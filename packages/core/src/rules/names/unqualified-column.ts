import { bareColumnCandidate } from "../shared/names.ts";
import { selectListColumns } from "../../analysis/locals.ts";
import { cteNames } from "../../syntax/fast/stmt.ts";
import { kw } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const unqualifiedColumn: Rule = {
  id: "names/unqualified-column",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A bare column name — \`status\` rather than \`o.status\` — that none of the statement's tables has.

**This is the rule that needs the most guards, and unguarded it is worse than nothing.** Every
reserved word, every alias, every block label and every output name in the file reads as a column that
no table has, and the result is thousands of warnings on a schema of any size. What makes it accurate
is the exclusions, and each removes a class rather than a case:

  - **Every relation in the statement must have resolved.** This is the important one. With a
    temporary or derived table in the mix, the set of valid columns is *unknown*, and claiming a name
    is not among them would be guessing — so the rule stands down entirely rather than half-checking.
  - **An alias or table name from the statement itself.** Without this the \`o\` of \`FROM orders o\` gets
    flagged, which is almost all of the remaining noise.
  - **An output name the \`SELECT\` defines**, which can also be used later in an \`ORDER BY\`.
  - **A \`WITH\` name**, which the statement defines exactly like an output alias.
  - **A local, a routine, or a temporary table** from anywhere in the project.

What survives all of that is a name that genuinely is not a column of any table in the query, in a
query where every table is known — and those, checked by hand, turn out to be real.`,

  check(ctx) {
    // With anything unresolved the valid set is unknown, and guessing is what this rule must not do.
    if (ctx.resolved.length === 0 || ctx.resolved.length !== ctx.relations.length) return;

    const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
    const ctes = cteNames(ctx.dialect, ctx.tokens, ctx.statement.from, ctx.statement.to);

    // Every `SELECT` in the statement contributes its output names.
    const outputAliases = new Set<string>();
    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!kw(ctx.tokens[i], "SELECT")) continue;
      for (const name of selectListColumns(ctx.tokens, i, ctx.statement.to, true).names) {
        outputAliases.add(fold(name));
      }
    }

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!bareColumnCandidate(ctx.tokens, i)) continue;
      const token = ctx.tokens[i]!;
      const key = fold(token.v);

      if (
        ctx.byAlias.has(key) ||
        outputAliases.has(key) ||
        ctes.has(key) ||
        ctx.locals.byName.has(key) ||
        ctx.catalog.table(token.v) ||
        ctx.catalog.routine(token.v) ||
        ctx.catalog.tempTable(token.v) ||
        ctx.resolved.some((table) => table.byName.has(key))
      ) {
        continue;
      }

      ctx.report(token, `unknown column: ${token.v}`);
    }
  },
};
