/** Small things more than one rule needs, and that mean nothing on their own. */

import { isKeyword } from "../dialects/mysql/index.ts";
import type { Routine } from "../model/routine.ts";
import type { Table } from "../model/table.ts";
import { kw, kwAny, matchingParen, punct, qualifiedName, splitCommas } from "../syntax/fast/tok.ts";
import type { Token } from "../syntax/types.ts";
import type { BaseContext } from "./rule.ts";

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

/**
 * Schemas the engine itself owns.
 *
 * Their tables are not in an application's DDL repo and are not supposed to be, so a reference to
 * one is not a dangling reference — it is a reference to something this repo was never going to
 * define.
 */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);

/** Operators where a NULL operand makes the whole expression NULL, with no error and no warning. */
export const ARITHMETIC: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

/**
 * Functions that absorb a NULL instead of propagating it.
 *
 * The aggregates are in the list for the same reason as `COALESCE`: `SUM` over a column with NULLs
 * skips them rather than returning NULL, so a NULL reaching one is not a defect.
 */
const NULL_SAFE: ReadonlySet<string> = new Set([
  "COALESCE",
  "IFNULL",
  "IF",
  "NULLIF",
  "ISNULL",
  "SUM",
  "COUNT",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
]);

/**
 * Does any function enclosing this token absorb the NULL?
 *
 * **Every** level is walked outwards, not only the innermost, because `COALESCE((a + b) * 2, 0)`
 * protects `a` from two parentheses further out. Reading a NULL is only a defect when the NULL
 * escapes, and a wrapper two levels up stops it just as well as one.
 */
export function insideNullSafe(tokens: readonly Token[], idx: number): boolean {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") {
      depth++;
    } else if (t.v === "(") {
      if (depth === 0) {
        const name = tokens[i - 1];
        if (name && name.t === "id" && !name.q && NULL_SAFE.has(name.v.toUpperCase())) return true;
      } else {
        depth--;
      }
    } else if (t.v === ";" && depth === 0) {
      return false;
    }
  }
  return false;
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

/** `a and b`, `a, b and c` — a list a person reads rather than one a machine emits. */
export function joinNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Is this identifier inside a `USE INDEX (...)` / `FORCE KEY (...)` hint, where names are indexes? */
function inIndexHint(tokens: readonly Token[], i: number): boolean {
  let j = i - 1;
  while (tokens[j] && (tokens[j]!.t === "id" || punct(tokens[j], ","))) j--;
  if (!punct(tokens[j], "(")) return false;

  for (let k = j - 1; k >= Math.max(j - 5, 0); k--) {
    if (kw(tokens[k], "INDEX") || kw(tokens[k], "KEY")) {
      const before = tokens[k - 1];
      return kw(before, "USE") || kw(before, "FORCE") || kw(before, "IGNORE");
    }
  }
  return false;
}

/**
 * Could this identifier be an unqualified column?
 *
 * Shared deliberately: the rule that asks whether a bare name exists and the rule that asks whether
 * it is ambiguous both start from this question, and they had better answer it identically. Two
 * copies of this predicate would drift, and the drift would show up as one rule contradicting the
 * other about the same token.
 *
 * The exclusions are each a class of name that is not a column at all:
 *
 *   - part of a qualified name, which is checked elsewhere with more to go on;
 *   - a function call, given away by the `(` that follows;
 *   - a block label, `retry: BEGIN` where it is declared and `LEAVE retry` where it is used;
 *   - a collation or character set — `x COLLATE utf8mb4_unicode_ci`, `CONVERT(x USING latin1)` —
 *     which name something of the server's rather than of the schema. A join's `USING` never
 *     reaches here, because MySQL demands a parenthesis after it;
 *   - an index named in an optimiser hint;
 *   - a session variable, which starts with `@`;
 *   - a reserved word, unless it was written delimited, which is what saying so means.
 */
export function bareColumnCandidate(tokens: readonly Token[], i: number): boolean {
  const token = tokens[i];
  if (!token || token.t !== "id") return false;
  return (
    !punct(tokens[i - 1], ".") &&
    !punct(tokens[i + 1], ".") &&
    !punct(tokens[i + 1], "(") &&
    !punct(tokens[i + 1], ":") &&
    !kw(tokens[i - 1], "LEAVE") &&
    !kw(tokens[i - 1], "ITERATE") &&
    !kw(tokens[i - 1], "COLLATE") &&
    !kw(tokens[i - 1], "USING") &&
    !inIndexHint(tokens, i) &&
    !token.v.startsWith("@") &&
    (token.q === true || !isKeyword(token.v))
  );
}

export interface AssignmentTargets {
  /** Token indexes that are the destination of a `SET` or an `INTO`. */
  written: ReadonlySet<number>;
  /** Token indexes sitting in an `OUT`/`INOUT` argument of a `CALL`, which the callee fills in. */
  callOuts: ReadonlySet<number>;
}

/**
 * Token indexes that **write** a local rather than read it.
 *
 * Two forms write one in the statement itself: `SET v = …`, with its comma-separated list, and the
 * `INTO v1, v2` of a `SELECT … INTO` or a `FETCH … INTO`. Telling a write from a read is the whole
 * basis of the variable rules — a variable that only ever appears as a destination is a variable
 * nobody uses.
 *
 * A third form, an argument in an `OUT`/`INOUT` position of a `CALL`, comes back **separately**,
 * because the two rules that need this disagree about it and both are right:
 *
 *   - To "never assigned, so this reads NULL" it is a write. `DECLARE v INT; CALL sp(x, v); … v …`
 *     is the ordinary way of getting a value out of a procedure, and counting that `v` as a read
 *     makes the rule accuse the idiom itself.
 *   - To "unused variable" it is **not** surplus. MySQL demands a variable in an `OUT` position
 *     whether the value is wanted or not, so a variable that exists purely to absorb one cannot be
 *     deleted — and greying out a name its author has no way of removing is worse than silence.
 *
 * The catalog has every signature with its parameter modes, so which argument is `OUT` is looked up
 * rather than guessed.
 */
export function assignmentTargets(ctx: BaseContext): AssignmentTargets {
  const { tokens, catalog } = ctx;
  const written = new Set<number>();
  const callOuts = new Set<number>();

  let i = 0;
  while (i < tokens.length) {
    if (kw(tokens[i], "SET")) {
      let j = i + 1;
      while (tokens[j]?.t === "id" && punct(tokens[j + 1], "=")) {
        written.add(j);

        // Skip the right-hand side, up to the comma that opens the next assignment. Reads in there
        // — the `v` of `SET v = v + 1` — stay reads, which is correct: the variable is used.
        let depth = 0;
        let k = j + 2;
        while (k < tokens.length) {
          const t = tokens[k]!;
          if (t.t === "punct") {
            if (t.v === "(") depth++;
            else if (t.v === ")") depth--;
            else if (depth === 0 && (t.v === ";" || t.v === ",")) break;
          }
          k++;
        }

        if (punct(tokens[k], ",")) j = k + 1;
        else break;
      }
      i = j + 1;
    } else if (kw(tokens[i], "INTO")) {
      // `INSERT INTO orders` comes through here and marks `orders`, which is harmless: only names
      // that are also declared locals are ever looked up in the result.
      let j = i + 1;
      while (tokens[j]?.t === "id") {
        written.add(j);
        if (punct(tokens[j + 1], ",")) j += 2;
        else break;
      }
      i = j + 1;
    } else if (kw(tokens[i], "CALL")) {
      const { name, nextIdx } = qualifiedName(tokens, i + 1);
      const routine: Routine | undefined = name ? catalog.routine(name) : undefined;
      if (routine?.params && punct(tokens[nextIdx], "(")) {
        const close = matchingParen(tokens, nextIdx);
        if (close !== -1 && close > nextIdx + 1) {
          splitCommas(tokens, nextIdx + 1, close - 1).forEach((span, slot) => {
            const param = routine.params[slot];
            // Only a lone identifier can be a destination. An expression in an `OUT` slot is a
            // different defect — the engine rejects it — and not these rules' business.
            if (param && param.mode !== "IN" && span.from === span.to && tokens[span.from]!.t === "id") {
              callOuts.add(span.from);
            }
          });
        }
        i = (close === -1 ? nextIdx : close) + 1;
      } else {
        i = nextIdx;
      }
    } else {
      i++;
    }
  }

  return { written, callOuts };
}

/**
 * Names that must never be looked up in the catalog.
 *
 * `DUAL` is MySQL's dummy table, and `NEW`/`OLD` are a trigger's rows: all three are the engine's
 * own, so their absence from a schema says nothing at all.
 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(["dual", "new", "old"]);
