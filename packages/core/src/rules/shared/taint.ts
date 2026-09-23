/**
 * Which variables were filled with a value that can be NULL for a reason the catalog can see.
 *
 * Both taint rules start here and neither is a place to keep a second copy: they would then disagree
 * about which variables are suspect, and a reader comparing two findings about the same variable
 * would have no way of telling which of them was right.
 *
 * Two shapes taint a variable, and they are two different reasons for the same NULL:
 *
 *   - A `SELECT col INTO v` where the catalog says `col` is nullable — the data itself may be NULL.
 *   - A `SET v = (SELECT …)` or a `SELECT … INTO v` that assigns from an aggregate other than `COUNT`
 *     or a non-key-lookup subquery — the NULL `query/nullable-scalar-subquery` reports when that
 *     shape reaches arithmetic directly, left instead in a variable for these rules to follow.
 */

import { isKeyLookup } from "./keys.ts";
import { aggregatesIn, readSubquery } from "./subqueries.ts";
import { statementSetTargets } from "./writes.ts";
import type { Table } from "../../model/table.ts";
import { relations } from "../../syntax/fast/stmt.ts";
import { kw, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { BaseContext, ScopeInfo } from "../rule.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";

/** What this needs of a context: the tokens, the catalog, the statements, and the scopes. */
type WithStatements = BaseContext & {
  statements(): readonly TokenRange[];
  scopeAt(index: number): ScopeInfo | undefined;
};

/** Where a tainted variable's NULL came from. */
export type Origin =
  /** The `Table.column` a `SELECT … INTO` filled it from, which the catalog says is nullable. */
  | { readonly kind: "column"; readonly column: string }
  /**
   * An aggregate or a subquery that answers NULL when it finds no row, upper-cased when it names an
   * aggregate (`"SUM"`) or `"subquery"` when the NULL comes from the search itself rather than one.
   */
  | { readonly kind: "empty"; readonly what: string };

/**
 * The leading clause of a finding, shared so the three rules that read `nullableSources` say the
 * same sentence about the same origin — a column's wording is unchanged from before this had a
 * second source, byte for byte, so an existing finding does not move under anyone.
 */
export function originClause(name: string, origin: Origin): string {
  return origin.kind === "column"
    ? `${name} comes from ${origin.column}, which is nullable`
    : `${name} was set from a ${origin.what} that is NULL over no rows`;
}

/**
 * Does a `( SELECT … )` opened at `open` and closed at `close` answer NULL for lack of a row, by the
 * criterion `query/nullable-scalar-subquery` reports on directly — an unprotected aggregate other
 * than `COUNT` with no `GROUP BY`, or a search rather than a lookup of one row by its key?
 *
 * The same two shapes, asked here instead of at the point the subquery is read: `SET v = (SELECT …)`
 * leaves the NULL in `v` rather than folding it into an expression on the spot, which is exactly what
 * `nullable-scalar-subquery`'s own docs say it deliberately leaves alone for this taint to pick up.
 */
function emptyResultOrigin(ctx: WithStatements, open: number, close: number): Origin | undefined {
  const sub = readSubquery(ctx.tokens, open, close);
  if (!sub) return undefined;

  const aggregate = aggregatesIn(ctx.tokens, sub.item);
  if (aggregate.any && !sub.grouped) {
    const at = aggregate.unprotected[0];
    return at === undefined ? undefined : { kind: "empty", what: ctx.tokens[at]!.v.toUpperCase() };
  }

  // Without an aggregate, "may match nothing" is a claim about the tables read, so it is only made
  // about tables the catalog holds. A temporary table, a derived one or a table from another
  // repository has keys this cannot see, and calling the read a search would be a guess.
  const scope = ctx.scopeAt(open + 1);
  if (!scope || scope.relations.length === 0) return undefined;
  if (scope.relations.some((r) => !r.name || r.cte || r.derived || !ctx.catalog.table(r.name))) return undefined;

  if (isKeyLookup(ctx, open + 1, close)) return undefined;
  return { kind: "empty", what: "subquery" };
}

/** Is there a `GROUP BY` at this range's own depth? A grouped aggregate answers per group, not once. */
function hasGroupBy(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "GROUP") && kw(tokens[i + 1], "BY")) return true;
  }
  return false;
}

/**
 * The tainted variables, folded, each with the `Origin` that explains why it may hold a NULL.
 *
 * `SELECT … INTO`'s list is matched against the `INTO` list **by position**, which is how MySQL
 * assigns them. A slot holding an expression, or a column from a relation that did not resolve,
 * taints nothing — the one exception being an unprotected aggregate, which taints on its own terms,
 * not the column's.
 */
export function nullableSources(ctx: WithStatements): Map<string, Origin> {
  const tainted = new Map<string, Origin>();
  const { tokens, dialect } = ctx;

  for (const statement of ctx.statements()) {
    // `SET v = (SELECT …)`, wherever one sits in the statement — including inside an `IF … THEN`.
    for (const idx of statementSetTargets(tokens, statement.from, statement.to)) {
      if (!punct(tokens[idx + 1], "=")) continue;
      const targetToken = tokens[idx]!;
      if (targetToken.t !== "id" || targetToken.q) continue;
      const name = dialect.foldIdentifier(targetToken.v, false);
      if (!ctx.locals.byName.has(name)) continue;

      const open = idx + 2;
      if (!punct(tokens[open], "(") || !kw(tokens[open + 1], "SELECT")) continue;
      const close = matchingParen(tokens, open);
      if (close === -1 || close > statement.to) continue;
      // The whole right-hand side has to be this one subquery: `(SELECT …) + 1` folds the NULL into
      // an expression on the spot, which is `query/nullable-scalar-subquery`'s finding, not a taint.
      if (close !== statement.to && !punct(tokens[close + 1], ",")) continue;

      const origin = emptyResultOrigin(ctx, open, close);
      // A column origin already names the stronger fact; the message it gave stays the one given.
      if (origin && tainted.get(name)?.kind !== "column") tainted.set(name, origin);
    }

    if (!kw(tokens[statement.from], "SELECT")) continue;

    // The `INTO` belonging to this `SELECT`, not to a subquery inside it.
    let into: number | undefined;
    let depth = 0;
    for (let i = statement.from; i <= statement.to; i++) {
      const t = tokens[i]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && kw(t, "INTO") && into === undefined) into = i;
    }
    if (into === undefined || into <= statement.from + 1) continue;

    const targets: string[] = [];
    let j = into + 1;
    while (tokens[j]?.t === "id") {
      targets.push(dialect.foldIdentifier(tokens[j]!.v, tokens[j]!.q ?? false));
      if (punct(tokens[j + 1], ",")) j += 2;
      else break;
    }

    const byAlias = new Map<string, Table>();
    for (const relation of relations(dialect, tokens, statement.from, statement.to)) {
      if (!relation.name) continue;
      const table = ctx.catalog.table(relation.name);
      if (!table) continue;
      byAlias.set(dialect.foldIdentifier(relation.alias ?? relation.name, false), table);
      byAlias.set(dialect.foldIdentifier(relation.name, relation.quoted === true), table);
    }

    // A `GROUP BY` hands back one row *per group*, so a slot's aggregate is as free to leave a group
    // unmatched as a query with no aggregate at all — the same reason `nullable-scalar-subquery`
    // stands down on one.
    const grouped = hasGroupBy(tokens, statement.from, statement.to);

    splitCommas(tokens, statement.from + 1, into - 1).forEach((span, slot) => {
      const target = targets[slot];
      if (!target || !ctx.locals.byName.has(target)) return;

      let table: Table | undefined;
      let column: { name: string; nullable: boolean } | undefined;

      if (span.from === span.to && tokens[span.from]!.t === "id") {
        // A bare `col`: the one relation that has it, if exactly one does.
        const key = dialect.foldIdentifier(tokens[span.from]!.v, tokens[span.from]!.q ?? false);
        for (const candidate of byAlias.values()) {
          const hit = candidate.byName.get(key);
          if (hit) {
            table = candidate;
            column = hit;
            break;
          }
        }
      } else if (span.to === span.from + 2 && punct(tokens[span.from + 1], ".")) {
        table = byAlias.get(dialect.foldIdentifier(tokens[span.from]!.v, tokens[span.from]!.q ?? false));
        column = table?.byName.get(dialect.foldIdentifier(tokens[span.to]!.v, tokens[span.to]!.q ?? false));
      }

      if (table && column?.nullable) {
        tainted.set(target, { kind: "column", column: `${table.name}.${column.name}` });
        return;
      }

      // An aggregate other than `COUNT`, left unprotected, is NULL over no rows — even when the item
      // is a bare column name that did not resolve to a nullable one, or resolved at all.
      const aggregate = aggregatesIn(tokens, span);
      if (aggregate.any && !grouped) {
        const at = aggregate.unprotected[0];
        if (at !== undefined && tainted.get(target)?.kind !== "column") {
          tainted.set(target, { kind: "empty", what: tokens[at]!.v.toUpperCase() });
        }
      }
    });
  }

  return tainted;
}
