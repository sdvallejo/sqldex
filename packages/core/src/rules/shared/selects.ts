/**
 * A `SELECT`'s list: where it ends, and how many values it produces.
 *
 * Two rules count a select list against something the catalog knows — `routine/select-into-arity`
 * against the variables after `INTO`, `query/insert-select-column-count` against the table being
 * written — and a disagreement between them about where the list ends would show up as one rule
 * counting an `ORDER BY` and the other not. So the bounds are decided once, here.
 *
 * Counting is only possible at all because of the catalog: `t.*` is one token as far as the lexer is
 * concerned and however many columns `t` has as far as the count is concerned, and nothing but the
 * schema can turn the first into the second.
 */

import { relation as resolveRelation } from "../../analysis/resolve.ts";
import { relations } from "../../syntax/fast/stmt.ts";
import { kw, kwAny, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";

/** Words between `SELECT` and the first item, which say nothing about what the item is. */
export const SELECT_MODIFIERS: ReadonlySet<string> = new Set([
  "ALL",
  "DISTINCT",
  "DISTINCTROW",
  "HIGH_PRIORITY",
  "STRAIGHT_JOIN",
  "SQL_SMALL_RESULT",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
  "SQL_NO_CACHE",
  "SQL_CACHE",
  "SQL_CALC_FOUND_ROWS",
]);

/**
 * Words that end the select list at its own depth.
 *
 * `INTO` is among them because MySQL takes it in two places — `SELECT a INTO v FROM t` and
 * `SELECT a FROM t INTO v` — and in the first it is what the list runs up against.
 */
const AFTER_LIST: ReadonlySet<string> = new Set([
  "FROM",
  "INTO",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "WINDOW",
  "PROCEDURE",
  "FOR",
  "LOCK",
  "ON",
]);

/** What can follow `INTO` and not be a variable: the two forms that write a file. */
const NOT_VARIABLES: ReadonlySet<string> = new Set(["OUTFILE", "DUMPFILE"]);

/**
 * The `INTO` of this range, at its own depth, or `-1`.
 *
 * Own depth so that a subquery's `INTO` is not mistaken for this one, and both spellings are found,
 * because these schemas contain both.
 */
export function intoAt(tokens: readonly Token[], from: number, to: number): number {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "INTO")) {
      return kwAny(tokens[i + 1], NOT_VARIABLES) === undefined ? i : -1;
    }
  }
  return -1;
}

/**
 * The items of the select list opened at `selectIdx`, or `undefined` when there are none to read.
 *
 * Ends at the first depth-zero word that starts another clause, at a `;`, or at the parenthesis that
 * wrapped the query — `INSERT INTO t (SELECT a, b FROM u)` is a select list of two, and a reader that
 * ran to the end of the range would count the tokens of the `FROM` as well.
 */
export function selectList(tokens: readonly Token[], selectIdx: number, to: number): TokenRange | undefined {
  let first = selectIdx + 1;
  while (kwAny(tokens[first], SELECT_MODIFIERS) !== undefined) first++;

  let depth = 0;
  for (let i = first; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) {
      if (depth === 0) return i > first ? { from: first, to: i - 1 } : undefined;
      depth--;
    } else if (depth === 0 && (punct(t, ";") || kwAny(t, AFTER_LIST) !== undefined)) {
      return i > first ? { from: first, to: i - 1 } : undefined;
    }
  }
  return to >= first ? { from: first, to } : undefined;
}

/** Is this item range exactly `*`? */
function bareStar(tokens: readonly Token[], item: TokenRange): boolean {
  return item.from === item.to && punct(tokens[item.from], "*");
}

/** The qualifier of an item range that is exactly `x.*`, or `undefined`. */
function qualifiedStar(tokens: readonly Token[], item: TokenRange): string | undefined {
  if (item.to !== item.from + 2) return undefined;
  const name = tokens[item.from];
  if (name?.t !== "id" || !punct(tokens[item.from + 1], ".") || !punct(tokens[item.from + 2], "*")) {
    return undefined;
  }
  return name.v;
}

/**
 * How many values the select list produces, or `undefined` when the schema cannot say.
 *
 * `queryFrom`/`queryTo` bound the query whose relations a star expands against, which is **not**
 * always the statement: in `INSERT INTO aud_t SELECT …, t.* FROM t` the statement's relations include
 * `aud_t`, the table being written, and counting its columns into the source's width would be
 * comparing the target with itself.
 *
 * It gives up rather than guess. A star over a relation the catalog does not hold — a temporary
 * table, a derived table, a database this repo does not define — has no width, and a count built on a
 * guess is worse than no count, because the rules built on this one report errors.
 */
export function selectWidth(
  ctx: StatementContext,
  list: TokenRange,
  queryFrom: number,
  queryTo: number,
): number | undefined {
  const { tokens, dialect } = ctx;
  const items = splitCommas(tokens, list.from, list.to);
  if (items.length === 0) return undefined;

  // Resolved lazily and once: most select lists have no star in them at all.
  let sources: { name?: string; alias?: string; columns?: number }[] | undefined;
  const resolve = (): typeof sources => {
    sources ??= relations(dialect, tokens, queryFrom, queryTo).map((item) => {
      const hit = resolveRelation({ dialect, catalog: ctx.catalog, schemas: ctx.schemas }, ctx.locals, item);
      return {
        name: item.name,
        alias: item.alias,
        ...(hit?.table ? { columns: hit.table.columns.length } : {}),
      };
    });
    return sources;
  };

  let total = 0;
  for (const item of items) {
    if (bareStar(tokens, item)) {
      // Every relation of the query, in order, so one unknown among them makes the whole width
      // unknown rather than too small.
      const all = resolve()!;
      if (all.length === 0 || all.some((source) => source.columns === undefined)) return undefined;
      total += all.reduce((sum, source) => sum + source.columns!, 0);
      continue;
    }

    const qualifier = qualifiedStar(tokens, item);
    if (qualifier !== undefined) {
      const fold = (name: string): string => dialect.foldIdentifier(name, false);
      const key = fold(qualifier);
      const source = resolve()!.find(
        (candidate) =>
          (candidate.alias !== undefined && fold(candidate.alias) === key) ||
          (candidate.alias === undefined && candidate.name !== undefined && fold(candidate.name) === key),
      );
      if (source?.columns === undefined) return undefined;
      total += source.columns;
      continue;
    }

    total += 1;
  }
  return total;
}
