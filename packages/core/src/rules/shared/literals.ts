/**
 * Reading a literal for what it is, and nothing it merely resembles.
 *
 * `query/literal-type-mismatch` and the strict-mode write rules (`write-value-too-long`,
 * `write-value-out-of-range`, `write-value-invalid-for-type`, `write-null-to-not-null`) all start
 * from the same question — is this token, or this small span of them, a value MySQL reads as a
 * plain literal — and a second answer to it would drift from the first the moment one of them grew
 * a case the other had not thought of.
 */

import { kw, punct, unquote } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";

/** Column types MySQL stores as a number, folded to lower case. */
export const NUMERIC: ReadonlySet<string> = new Set([
  "int",
  "integer",
  "bigint",
  "smallint",
  "tinyint",
  "mediumint",
  "decimal",
  "dec",
  "numeric",
  "fixed",
  "float",
  "double",
  "real",
  "bit",
]);

/** Column types MySQL stores as text, folded to lower case. */
export const TEXT: ReadonlySet<string> = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"]);

/** Is this string a number as MySQL would read one, so that comparing it costs nothing? */
export function readsAsNumber(literal: string): boolean {
  const text = unquote(literal).trim();
  return text.length > 0 && Number.isFinite(Number(text));
}

export interface Literal {
  kind: "str" | "num" | "null";
  /**
   * For `str`, the value with its quotes and escapes stripped — what MySQL would actually store.
   * For `num`, the digits as written, with a leading `-` folded in for a signed one. For `null`,
   * the word `NULL` itself.
   */
  text: string;
}

/**
 * Reads `range` as a literal — a bare string, an optionally-signed number, or `NULL` — the one
 * thing every write-checking rule needs before it can say anything about a value at all.
 *
 * `undefined` for anything else: an expression, a parameter, a variable, the word `DEFAULT`, and a
 * literal these rules do not judge — `_utf8mb4'…'`, `X'…'`. Deliberately narrow. A rule built on
 * this one is only as trustworthy as its refusal to guess at an expression's value, and widening it
 * to fold in more shapes would widen every rule that calls it at once — exactly the failure a
 * shared helper exists to prevent.
 */
export function literalOf(tokens: readonly Token[], range: TokenRange): Literal | undefined {
  const { from, to } = range;
  if (from > to) return undefined;

  if (from === to) {
    const token = tokens[from]!;
    if (token.t === "str") return { kind: "str", text: unquote(token.v) };
    if (token.t === "num") return { kind: "num", text: token.v };
    if (kw(token, "NULL")) return { kind: "null", text: "NULL" };
    return undefined;
  }

  if (to === from + 1 && (punct(tokens[from], "-") || punct(tokens[from], "+")) && tokens[to]?.t === "num") {
    const sign = punct(tokens[from], "-") ? "-" : "";
    return { kind: "num", text: sign + tokens[to]!.v };
  }

  return undefined;
}
