/**
 * Whether a query can come back with more than one row, which two rules ask in two places.
 *
 * One asks it of a subquery read as a value, the other of a `SELECT … INTO`. The failure is the same
 * shape both times — MySQL stops the statement rather than picking a row — and the three things that
 * make one row certain are the same three, so they are answered here once. Two copies of "does this
 * return one row" would drift, and the drift would show up as one rule reporting a query the other
 * calls fine.
 */

import type { Table } from "../../model/table.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";

/** Aggregates fold a whole group into one row, which is the other way of having only one. */
export const AGGREGATES: ReadonlySet<string> = new Set([
  "AVG",
  "BIT_AND",
  "BIT_OR",
  "BIT_XOR",
  "COUNT",
  "GROUP_CONCAT",
  "JSON_ARRAYAGG",
  "JSON_OBJECTAGG",
  "MAX",
  "MIN",
  "STD",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "SUM",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
]);

/**
 * Does the query fold its rows into one, by aggregating without grouping?
 *
 * The `GROUP BY` is the half that is easy to forget: `SELECT SUM(x) FROM t GROUP BY y` is an
 * aggregate and still returns one row *per group*, so it is exactly as capable of returning several
 * as the query with no aggregate at all.
 *
 * Aggregates inside a nested subquery are skipped whole, since folding that query's rows says
 * nothing about how many this one returns.
 */
export function foldsToOneRow(tokens: readonly Token[], from: number, to: number): boolean {
  let aggregate = false;
  let depth = 0;

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "GROUP") && kw(tokens[i + 1], "BY")) return false;
    else if (t.t === "id" && !t.q && punct(tokens[i + 1], "(") && AGGREGATES.has(t.v.toUpperCase())) {
      aggregate = true;
    }
  }
  return aggregate;
}

/** `LIMIT 1`, in either of its two spellings, at the query's own depth. */
export function limitsToOne(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "LIMIT")) {
      // `LIMIT 1` and `LIMIT 0, 1` both take one row; the count is the last number either way.
      const count = punct(tokens[i + 2], ",") ? tokens[i + 3] : tokens[i + 1];
      return count?.t === "num" && Number(count.v) === 1;
    }
  }
  return false;
}

/** A unique key the `WHERE` starts and does not finish, with the columns it left free. */
export interface HalfKey {
  key: readonly string[];
  /** The key's own columns the `WHERE` fixes, which is not every column it fixes. */
  held: string[];
  free: string[];
}

/**
 * The unique key this search starts and abandons, if there is one.
 *
 * **This is the whole rule.** A `WHERE` that mentions nothing any key mentions is a search the
 * schema has no opinion about — the column may well be unique in practice, and saying otherwise
 * would be guessing out loud once per query in the repo. A `WHERE` that fixes *part* of a declared
 * key is different: the schema itself says the rest of that key is free to vary, so a second row is
 * not a hypothesis, it is what the key is for.
 *
 * Every key is read before answering, because covering one of them whole is enough — and a table
 * whose primary key is `(account_id, holder_id)` will usually also carry `UNIQUE (account_id)`.
 */
export function halfPinnedKey(
  fold: (name: string) => string,
  table: Table,
  pinned: readonly string[],
): HalfKey | undefined {
  const fixed = new Set(pinned.map(fold));
  const keys = [table.primaryKey, ...table.indexes.filter((index) => index.unique).map((index) => index.columns)];

  let half: HalfKey | undefined;
  for (const key of keys) {
    if (key.length === 0) continue;
    const free = key.filter((name) => !fixed.has(fold(name)));
    // Any key covered whole is one row, whatever the other keys have left over: a query that fixes
    // `UNIQUE (account_id)` is pinned down even though the primary key `(account_id, holder_id)` has
    // a column to spare.
    if (free.length === 0) return undefined;
    if (free.length < key.length) half ??= { key, held: key.filter((name) => fixed.has(fold(name))), free };
  }
  return half;
}

