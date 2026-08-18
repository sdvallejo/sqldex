/** Reading an identifier for what it is: a column, a list of them, or somebody else's schema. */

import { isKeyword } from "../../dialects/mysql/index.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";

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

/**
 * Names that must never be looked up in the catalog.
 *
 * `DUAL` is MySQL's dummy table, and `NEW`/`OLD` are a trigger's rows: all three are the engine's
 * own, so their absence from a schema says nothing at all.
 */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(["dual", "new", "old"]);
