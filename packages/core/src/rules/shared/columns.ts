/**
 * Which column a name in a statement refers to, and which part of the statement is assignment.
 *
 * Both rules that read `column <op> literal` need exactly this much: `query/literal-type-mismatch`
 * to compare the types, `query/enum-value-not-defined` to compare the value against the codes the
 * column declares. Keeping one copy is what stops them disagreeing about which column a bare name
 * belongs to, which would show up as one rule reporting a name the other resolved elsewhere.
 */

import type { Column } from "../../model/table.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { StatementContext } from "../rule.ts";

/** The column a qualified or bare name refers to, when the catalog has exactly one answer for it. */
export function columnAt(ctx: StatementContext, index: number): { column: Column; text: string } | undefined {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const token = tokens[index];
  if (token?.t !== "id") return undefined;

  if (punct(tokens[index - 1], ".") && tokens[index - 2]?.t === "id") {
    const alias = fold(tokens[index - 2]!.v);
    const relation = ctx.aliasesFor(index - 2, alias).get(alias);
    const table = relation?.name ? ctx.catalog.table(relation.name) : undefined;
    const column = table?.byName.get(fold(token.v));
    return column ? { column, text: `${tokens[index - 2]!.v}.${token.v}` } : undefined;
  }
  if (punct(tokens[index + 1], ".") || punct(tokens[index - 1], ".")) return undefined;

  // A bare name has to belong to exactly one of this query's relations, or there is nothing to
  // compare against: two tables with a `code` column of different types are two different questions.
  const owners = ctx.relations
    .map((relation) => (relation.name ? ctx.catalog.table(relation.name) : undefined))
    .map((table) => table?.byName.get(fold(token.v)))
    .filter((column) => column !== undefined);
  return owners.length === 1 ? { column: owners[0]!, text: token.v } : undefined;
}

/**
 * The range of an `UPDATE`'s `SET`, which is assignment and not comparison.
 *
 * An empty range when there is none, so the test is one comparison either way rather than a branch.
 */
export function setClause(ctx: StatementContext): { from: number; to: number } {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "SET")) {
      for (let j = i + 1; j <= ctx.statement.to; j++) {
        if (punct(tokens[j], "(")) depth++;
        else if (punct(tokens[j], ")")) depth--;
        else if (depth === 0 && (kw(tokens[j], "WHERE") || punct(tokens[j], ";"))) return { from: i, to: j };
      }
      return { from: i, to: ctx.statement.to + 1 };
    }
  }
  return { from: -1, to: -1 };
}
