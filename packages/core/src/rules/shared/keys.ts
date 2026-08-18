/**
 * What pins a row down: the columns a clause fixes, and whether they add up to a key.
 *
 * Four rules ask this and they had better agree — a join that half-fixes a composite key, a subquery
 * read as one value, a `SELECT … INTO`, a search read as a lookup. All of them are the same question
 * asked in different places.
 */

import type { Table } from "../../model/table.ts";
import { kw, kwAny, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";

/**
 * Is `wanted` the leftmost prefix of `columns`, position by position?
 *
 * Position is the whole point. An index on `(register_id, store_id)` cannot serve a lookup by
 * `(store_id, register_id)`: the engine reads an index left to right, so the first column has to
 * be the first column. Comparing the two as sets — or, worse, as their names joined together —
 * would call that covered, and the mistake it would then miss is the common one.
 */
export function isLeftPrefix(wanted: readonly string[], columns: readonly string[]): boolean {
  if (wanted.length > columns.length) return false;
  return wanted.every((name, i) => columns[i]!.toLowerCase() === name.toLowerCase());
}

/** Clauses that end a `WHERE`, and after which an equality is no longer part of it. */
const WHERE_BOUNDARY: ReadonlySet<string> = new Set(["GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTO"]);

/**
 * The columns a `WHERE` fixes to a single value.
 *
 * Two rules ask this and they had better agree: one wants to know whether the clause finishes a
 * composite key a join only half fixed, the other whether a subquery is a lookup of one row rather
 * than a search that may find none. Both questions are "what does this clause pin down", and a
 * second copy of the answer would drift.
 *
 * Only equalities at the clause's own depth, and only when no `OR` shares that depth: `a = 1 AND b =
 * 2 OR c` does not fix anything, and telling the difference for real is a parse this backend does
 * not do. What is on the other side of the `=` is not examined, because it does not matter — a
 * parameter, a literal or another relation's column all hold still while the table is scanned.
 *
 * References qualified by `label` always count. Bare names count only when `bare` says so — a caller
 * reading one relation's `WHERE` out of a join cannot tell whose column an unqualified name is,
 * while a caller looking at a query over a single table has nothing else it could belong to.
 */
export function pinnedByWhere(
  tokens: readonly Token[],
  scope: { from: number; to: number },
  fold: (name: string) => string,
  label?: string,
  bare = false,
): string[] {
  let where = -1;
  let depth = 0;
  for (let i = scope.from; i <= scope.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "WHERE")) {
      where = i;
      break;
    }
  }
  if (where === -1) return [];

  const columns: string[] = [];
  depth = 0;
  for (let i = where + 1; i <= scope.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && kw(t, "OR")) {
      return [];
    } else if (depth === 0 && (kwAny(t, WHERE_BOUNDARY) !== undefined || punct(t, ";"))) {
      break;
    } else if (depth === 0 && punct(t, "=")) {
      for (const side of [i - 3, i + 1] as const) {
        if (tokens[side]?.t !== "id" || !punct(tokens[side + 1], ".") || tokens[side + 2]?.t !== "id") continue;
        if (fold(tokens[side]!.v) === label) columns.push(tokens[side + 2]!.v);
      }
      if (!bare) continue;
      for (const side of [i - 1, i + 1] as const) {
        const name = tokens[side];
        if (name?.t !== "id" || punct(tokens[side - 1], ".") || punct(tokens[side + 1], ".")) continue;
        columns.push(name.v);
      }
    }
  }
  return columns;
}

/**
 * Do these columns pin the table to at most one row?
 *
 * The primary key or any unique index, wholly covered. Partly covered is not covered: half of a
 * two-column key identifies a group of rows, and a group is not a row.
 */
export function coversUniqueKey(
  fold: (name: string) => string,
  table: Table,
  columns: readonly string[],
): boolean {
  const fixed = new Set(columns.map(fold));
  const covered = (key: readonly string[]): boolean => key.length > 0 && key.every((name) => fixed.has(fold(name)));

  if (covered(table.primaryKey)) return true;
  return table.indexes.some((index) => index.unique && covered(index.columns));
}

/** One query over one table, with what its `WHERE` fixes — the shape a row can be looked up in. */
export interface SingleTableQuery {
  table: Table;
  /** The columns an equality in the `WHERE` fixes to one value. */
  pinned: string[];
}

/**
 * The one table a scalar subquery reads, and what its `WHERE` pins down — or `undefined` when there
 * is more than one table, or none the catalog knows.
 *
 * A join disqualifies it whatever the `WHERE` pins, because the second table decides on its own how
 * many rows come back: none, if it matches nothing, and several, if it matches several. Both are
 * what the callers of this are trying to rule out.
 */
export function singleTableQuery(
  ctx: StatementContext,
  sel: number,
  close: number,
): SingleTableQuery | undefined {
  const scope = ctx.scopeAt(sel);
  if (!scope || scope.to > close) return undefined;

  const only = scope.relations.length === 1 ? scope.relations[0] : undefined;
  if (!only?.name || only.cte || only.derived) return undefined;

  const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
  const table = ctx.catalog.table(only.name);
  if (!table) return undefined;

  // Filtered to columns the table actually has: an unqualified `=` reads both sides, and the other
  // one is normally a parameter or a literal that only looks like a name.
  const pinned = pinnedByWhere(ctx.tokens, scope, fold, fold(only.alias ?? only.name), true).filter((name) =>
    table.byName.has(fold(name)),
  );
  return { table, pinned };
}

/**
 * Is this subquery a **lookup** of a row rather than a search that may find none?
 *
 * One table, and a `WHERE` that fixes a whole primary key or unique index of it: `SELECT Valor FROM
 * Settings WHERE Parameter = 'X'` is somebody reading a row they know is there, and telling them it
 * might not be is a claim about their data rather than about their query. A search — a range of
 * dates, a status that is not one value, a join to another table — is the opposite: finding nothing
 * is one of its ordinary outcomes.
 *
 * The catalog is what tells the two apart, and nothing else can: the same `WHERE` shape is a lookup
 * against one table and a search against another, and only the keys say which.
 */
export function isKeyLookup(ctx: StatementContext, sel: number, close: number): boolean {
  const query = singleTableQuery(ctx, sel, close);
  if (!query) return false;
  return coversUniqueKey((name) => ctx.dialect.foldIdentifier(name, false), query.table, query.pinned);
}
