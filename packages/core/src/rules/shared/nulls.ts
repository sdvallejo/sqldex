/** What a NULL does to an expression, and what absorbs it before it gets out. */

import { punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";

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
