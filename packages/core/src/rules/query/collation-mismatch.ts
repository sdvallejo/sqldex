import type { Column, Table } from "../../model/table.ts";
import { punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** The catalog column behind a qualified `alias.name`, when both ends are known. */
function qualifiedColumn(
  ctx: StatementContext,
  aliasToken: Token,
  nameToken: Token,
): { column: Column; table: Table } | undefined {
  const relation = ctx.byAlias.get(ctx.dialect.foldIdentifier(aliasToken.v, aliasToken.q ?? false));
  if (!relation?.name) return undefined;
  const table = ctx.catalog.table(relation.name);
  if (!table) return undefined;
  const column = table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q ?? false));
  return column ? { column, table } : undefined;
}

export const collationMismatch: Rule = {
  id: "query/collation-mismatch",
  group: "query",
  severity: "warn",
  dialects: ["mysql"],
  scope: "statement",
  docs: `A join comparing two text columns that do not share a collation.

MySQL either refuses the comparison outright — *Illegal mix of collations* — or silently coerces one
side, which rules out the index on it. Either way, this is the only place a minority collation costs
anything.

**The rule this replaces is worth knowing about.** The obvious version is "flag every column whose
collation is not the schema's dominant one", and it is a bad rule: what it finds is archaeology. The
columns it reports are the migration copies, the \`aux_\` scratch tables and the log tables left behind
by whichever encoding migration happened years ago, and the ones that are not are referenced by no
procedure at all. Warning about any of them is arguing with history rather than finding a defect.

What is worth reporting is where the two collations actually **meet**. Expect that to be nothing on a
schema whose old tables are never joined against its current ones — and the value is the day somebody
does.

**The dominant collation is never named.** The rule compares two columns against each other, so a
schema that is entirely one collation is as quiet as a schema that is entirely another. It only
compares equality between two *qualified* names: a column against a literal is a different question,
and the engine coerces the literal anyway.`,

  check(ctx) {
    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!punct(ctx.tokens[i], "=")) continue;
      if (!punct(ctx.tokens[i - 2], ".") || !punct(ctx.tokens[i + 2], ".")) continue;

      const leftAlias = ctx.tokens[i - 3];
      const leftName = ctx.tokens[i - 1];
      const rightAlias = ctx.tokens[i + 1];
      const rightName = ctx.tokens[i + 3];
      if (leftAlias?.t !== "id" || !leftName || rightAlias?.t !== "id" || rightName?.t !== "id") continue;

      const left = qualifiedColumn(ctx, leftAlias, leftName);
      const right = qualifiedColumn(ctx, rightAlias, rightName);
      if (!left?.column.collation || !right?.column.collation) continue;
      if (left.column.collation === right.column.collation) continue;

      ctx.report(
        rightName,
        `${leftAlias.v}.${left.column.name} is ${left.column.collation} and ` +
          `${rightAlias.v}.${right.column.name} is ${right.column.collation}: ` +
          "the comparison cannot use the index",
      );
    }
  },
};
