/** Reading an identifier for what it is: a column, a list of them, or somebody else's schema. */

import { isKeyword } from "../../dialects/mysql/index.ts";
import { selectListColumns } from "../../analysis/locals.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";

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

/**
 * The output names a statement's own `SELECT`s define, folded — which an `ORDER BY`, and nothing
 * else in this statement, may then refer back to.
 *
 * Shared because more than one rule asks the same question about a bare name that is not a column
 * of anything: whether the statement itself gave it that name, rather than a table.
 */
export function selectOutputAliases(ctx: StatementContext): Set<string> {
  const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
  const outputAliases = new Set<string>();
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (!kw(ctx.tokens[i], "SELECT")) continue;
    for (const name of selectListColumns(ctx.tokens, i, ctx.statement.to, true).names) {
      outputAliases.add(fold(name));
    }
  }
  return outputAliases;
}

/**
 * Is this bare name one the statement, the routine or the catalog already accounts for — an alias,
 * an output name, a `WITH` name, a local, a routine, a table, or a column of one of the statement's
 * own (fully resolved) relations?
 *
 * Extracted from `names/unqualified-column`, which needed exactly this question first: a bare name
 * that fails every one of these is not a column of anything in scope, and that rule and
 * `routine/undeclared-variable` both start from it — the first to say a name is not a column, the
 * second to say a name is not a variable either, and they had better agree about what "already
 * accounted for" means or one would contradict the other on the same token.
 */
export function knownBareName(
  ctx: StatementContext,
  i: number,
  outputAliases: ReadonlySet<string>,
  ctes: ReadonlySet<string>,
): boolean {
  const token = ctx.tokens[i]!;
  const key = ctx.dialect.foldIdentifier(token.v, false);
  return (
    ctx.byAlias.has(key) ||
    outputAliases.has(key) ||
    ctes.has(key) ||
    ctx.locals.byName.has(key) ||
    ctx.catalog.table(token.v) !== undefined ||
    ctx.catalog.routine(token.v) !== undefined ||
    ctx.catalog.tempTable(token.v) !== undefined ||
    ctx.resolved.some((table) => table.byName.has(key))
  );
}
