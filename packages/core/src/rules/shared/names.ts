/** Reading an identifier for what it is: a column, a list of them, or somebody else's schema. */

import { selectListColumns } from "../../analysis/locals.ts";
import { kw } from "../../syntax/fast/tok.ts";
import type { Table } from "../../model/table.ts";
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

// Moved to the analysis layer, which find-references needs just as much as the rules do; re-exported
// so a rule keeps importing it from here and the two can never answer differently.
export { bareColumnCandidate } from "../../analysis/owners.ts";

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
 * own (fully resolved) relations? `tables` narrows that last part to the ones a name can actually
 * reach — its query and the queries enclosing it — when the caller knows them.
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
  tables: readonly Table[] = ctx.resolved,
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
    tables.some((table) => table.byName.has(key))
  );
}
