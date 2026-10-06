/**
 * A `LIMIT` with no `ORDER BY` beside it, which two rules ask about and say different things of.
 *
 * One reports the query that skips rows, which several calls have to agree about, the other the one
 * that only keeps some. Both have to agree on what a query is, where its `LIMIT` and
 * `ORDER BY` are, and which of them are not worth a word at all — a drift in any of those would show
 * up as one rule reporting a `LIMIT` the other calls fine, or as both reporting the same one.
 * So the walk and the guards they share are here once, and each rule decides only its own half.
 */

import { kw, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";
import { foldsToOneRow, limitAt, type LimitClause } from "./rows.ts";
import { selectList } from "./selects.ts";

/** A `LIMIT` that survived every guard, with the query it belongs to. */
export interface UnorderedLimit {
  limit: LimitClause;
  /** The query's first `SELECT`: where its scope starts. */
  select: number;
  /**
   * Where the query ends, the way `isKeyLookup` wants it: the parenthesis that closes a nested
   * `(SELECT …)`, or the statement's last token for the statement's own.
   */
  close: number;
  /** More than one `SELECT` at this depth, which is a `UNION` of them. */
  union: boolean;
}

/** One number, one string or `NULL`, optionally signed and optionally named: a value no row changes. */
function isLiteralItem(tokens: readonly Token[], item: TokenRange): boolean {
  let { from, to } = item;
  // `1 AS one`: the name says nothing about the value.
  if (to - 2 >= from && kw(tokens[to - 1], "AS")) to -= 2;
  if ((punct(tokens[from], "-") || punct(tokens[from], "+")) && tokens[from + 1]?.t === "num") from++;
  if (from !== to) return false;
  const t = tokens[from]!;
  return t.t === "num" || t.t === "str" || kw(t, "NULL");
}

/** Is every item of every select list at this depth a literal, so that any row answers alike? */
function onlyLiterals(tokens: readonly Token[], selects: readonly number[], to: number): boolean {
  return selects.every((select) => {
    const list = selectList(tokens, select, to);
    if (!list) return false;
    const items = splitCommas(tokens, list.from, list.to);
    return items.length > 0 && items.every((item) => isLiteralItem(tokens, item));
  });
}

/**
 * Every query of the statement that has a `LIMIT` and no `ORDER BY` at its own depth, minus the ones
 * no rule has anything to say about.
 *
 * A query is one depth: the statement's own, or what a pair of parentheses encloses, each judged by
 * its own clauses and not by its parent's — an `ORDER BY` outside a subquery orders the outer rows
 * and leaves the inner `LIMIT` exactly as unordered as it was. Only a depth that has a `SELECT` of
 * its own is a query, which is what keeps an `UPDATE` or a `DELETE` with a `LIMIT` out: that is a
 * different statement and a different question, while a `SELECT` nested inside one is judged like any
 * other.
 *
 * Silent, in every case, for: `LIMIT 0`; an aggregate with no `GROUP BY`, which is one row anyway; a
 * subquery that only asks `EXISTS`; and a select list of nothing but literals.
 */
export function unorderedLimits(ctx: StatementContext): UnorderedLimit[] {
  const { tokens } = ctx;
  const found: UnorderedLimit[] = [];

  const walk = (from: number, to: number, close: number, exists: boolean): void => {
    const selects: number[] = [];
    const limits: number[] = [];
    let ordered = false;
    const nested: { open: number; close: number }[] = [];

    for (let i = from; i <= to; i++) {
      const t = tokens[i]!;
      if (punct(t, "(")) {
        const end = matchingParen(tokens, i);
        if (end === -1 || end > to) break;
        nested.push({ open: i, close: end });
        i = end;
      } else if (kw(t, "SELECT")) selects.push(i);
      else if (kw(t, "ORDER") && kw(tokens[i + 1], "BY")) ordered = true;
      else if (kw(t, "LIMIT")) limits.push(i);
    }

    for (const inner of nested) {
      walk(inner.open + 1, inner.close - 1, inner.close, kw(tokens[inner.open - 1], "EXISTS"));
    }

    if (selects.length === 0 || ordered || exists || limits.length === 0) return;
    if (foldsToOneRow(tokens, from, to)) return;
    if (onlyLiterals(tokens, selects, to)) return;

    for (const index of limits) {
      const limit = limitAt(tokens, index);
      if (limit.count === 0) continue;
      found.push({ limit, select: selects[0]!, close, union: selects.length > 1 });
    }
  };

  walk(ctx.statement.from, ctx.statement.to, ctx.statement.to, false);
  return found;
}
