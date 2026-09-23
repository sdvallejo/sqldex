/**
 * What a `( SELECT … )` read as a single value says about an empty result.
 *
 * `query/nullable-scalar-subquery` and the taint the three `routine/nullable-*` rules follow both ask
 * the same question about a scalar subquery — is it an aggregate that answers NULL over no rows, or a
 * search rather than a lookup — and they had better agree: the one reads a subquery used directly as
 * an operand, the other a subquery assigned straight to a variable with `SET v = (SELECT …)`.
 */

import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";

/** Words between `SELECT` and the first item, which say nothing about what the item is. */
const SELECT_MODIFIERS: ReadonlySet<string> = new Set([
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
 * Aggregates that answer an empty set with NULL.
 *
 * `COUNT` is deliberately not here and that is the whole distinction the rule turns on: over no rows
 * it answers `0`, which is a number, and arithmetic on it is safe. Every other aggregate answers
 * NULL, and the answer looks exactly like the one for "the sum happens to be null".
 */
const AGGREGATES: ReadonlySet<string> = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
  "STD",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
]);

/** What turns the NULL back into a value — inside the subquery, where it can still help. */
const ABSORBING: ReadonlySet<string> = new Set(["COALESCE", "IFNULL"]);

/** Clauses that end the select list, and after which a `GROUP BY` may still show up. */
const AFTER_ITEM: ReadonlySet<string> = new Set(["FROM", "INTO"]);

interface Range {
  from: number;
  to: number;
}

/**
 * Is this token index inside a `COALESCE` or an `IFNULL`, without leaving `from`?
 *
 * Bounded at the item on purpose: this asks whether the NULL is absorbed *inside the subquery*,
 * which is where absorbing it fixes anything. A `COALESCE` around the whole expression outside is
 * exactly the shape this rule is about, and walking out to it would silence every finding.
 */
export function absorbedWithin(tokens: readonly Token[], idx: number, from: number): boolean {
  let depth = 0;
  for (let i = idx - 1; i >= from; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = tokens[i - 1];
      if (name?.t === "id" && !name.q && ABSORBING.has(name.v.toUpperCase())) return true;
    }
  }
  return false;
}

/**
 * The aggregate calls of a select item, with any nested subquery of its own skipped whole.
 *
 * The skipping is what keeps `SELECT (SELECT SUM(x) FROM y) FROM z` honest: that `SUM` belongs to
 * the inner query and says nothing about whether *this* one returns a row.
 */
export function aggregatesIn(tokens: readonly Token[], range: Range): { any: boolean; unprotected: number[] } {
  let any = false;
  const unprotected: number[] = [];

  for (let i = range.from; i <= range.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? range.to : close;
      continue;
    }
    if (t.t !== "id" || t.q || !punct(tokens[i + 1], "(")) continue;

    const name = t.v.toUpperCase();
    if (name === "COUNT") any = true;
    else if (AGGREGATES.has(name)) {
      any = true;
      if (!absorbedWithin(tokens, i, range.from)) unprotected.push(i);
    }
  }
  return { any, unprotected };
}

export interface Subquery {
  /** The single select item, from the first token after `SELECT` up to the `FROM`. */
  item: Range;
  /** Whether a `GROUP BY` at its own depth can leave it with no row at all. */
  grouped: boolean;
}

/**
 * What the rule needs to know about a `( SELECT … )`, or `undefined` when it is not its business.
 *
 * Two shapes come back undefined and neither is a defect: a select list of several items is not a
 * scalar at all — MySQL rejects it in this position — and a `SELECT` with no `FROM` computes its one
 * row out of thin air, so "no rows matched" cannot happen to it.
 */
export function readSubquery(tokens: readonly Token[], open: number, close: number): Subquery | undefined {
  let i = open + 2;
  while (kwAny(tokens[i], SELECT_MODIFIERS) !== undefined) i++;

  let depth = 0;
  let end = -1;
  for (let j = i; j < close; j++) {
    const t = tokens[j]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth !== 0) continue;
    // A comma at the item's own depth is a second item, so this was never a scalar.
    else if (punct(t, ",")) return undefined;
    else if (kwAny(t, AFTER_ITEM) !== undefined) {
      end = j;
      break;
    }
  }
  if (end === -1 || end === i) return undefined;

  let grouped = false;
  depth = 0;
  for (let j = end + 1; j < close; j++) {
    const t = tokens[j]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "GROUP") && kw(tokens[j + 1], "BY")) {
      grouped = true;
      break;
    }
  }

  return { item: { from: i, to: end - 1 }, grouped };
}
