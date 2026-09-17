import { BUILTIN_NAMES, SYSTEM_SCHEMAS } from "../shared/names.ts";
import { qualifierIn } from "../../analysis/resolve.ts";
import type { Rule } from "../rule.ts";

export const unknownColumn: Rule = {
  id: "names/unknown-column",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A qualified \`x.column\` where \`x\` resolves to a table that has no such column.

The other half of reading a qualified reference: \`names/unknown-alias\` answers whether the qualifier
means anything, and this one answers whether the column does. Splitting them is worth a rule apiece
because they are different mistakes with different fixes — a stale alias against a renamed column.

A derived table's columns are known when every item in its query's first branch has a name — under a
\`UNION\` the first branch is what names the result — and reported against exactly like a real table's.
The rule stands down on one instead: an item that is an unaliased expression, a \`*\` that could not be
traced to exactly one relation or that reads a temporary table, a relation that is a table function such as \`JSON_TABLE\`, an alias that
carries its own column list, or a common table expression, whose columns come out of a query this rule
does not read either.

A temporary table's columns may not have been inferable, and a relation that failed to resolve has none
to compare against; both are left alone rather than guessed at, which is what keeps flagging a reference
into a temporary table built by another procedure off the table.

\`NEW.col\` and \`OLD.col\` inside a trigger *are* checked, against the trigger's own table, which is
known exactly.`,

  check(ctx) {
    const resolveCtx = { dialect: ctx.dialect, catalog: ctx.catalog, schemas: ctx.schemas };

    for (const dot of ctx.qualified) {
      const qualifierToken = ctx.tokens[dot - 1]!;
      const nameToken = ctx.tokens[dot + 1]!;
      const key = ctx.dialect.foldIdentifier(qualifierToken.v, qualifierToken.q ?? false);
      const columnKey = ctx.dialect.foldIdentifier(nameToken.v, nameToken.q ?? false);

      if (BUILTIN_NAMES.has(key)) {
        // The trigger's row, whose columns are the trigger's table's.
        const triggerTable =
          ctx.locals.triggerTable !== undefined ? ctx.catalog.table(ctx.locals.triggerTable) : undefined;
        if (triggerTable && !triggerTable.byName.has(columnKey)) {
          ctx.report(nameToken, `${triggerTable.name} has no column ${nameToken.v}`);
        }
        continue;
      }

      if (qualifierToken.v.startsWith("@")) continue;
      if (SYSTEM_SCHEMAS.has(key)) continue;
      if (ctx.catalog.table(nameToken.v)) continue;

      const aliases = ctx.aliasesFor(dot, key);
      // Not declared here: that is the other rule's finding, not this one's.
      if (!aliases.has(key)) continue;

      const resolved = qualifierIn(resolveCtx, aliases, ctx.locals, qualifierToken.v, ctx.tokens);
      if (!resolved || resolved.kind === "temp_table") continue;

      if (resolved.kind === "derived") {
        // Incomplete: something in the query could not be named, so a miss here may only be this
        // pass's, not the statement's.
        if (resolved.complete !== true || !resolved.columns) continue;
        const known = resolved.columns.some((name) => ctx.dialect.foldIdentifier(name, false) === columnKey);
        if (!known) {
          ctx.report(nameToken, `derived table ${qualifierToken.v} has no column ${nameToken.v}`);
        }
        continue;
      }

      if (resolved.table && !resolved.table.byName.has(columnKey)) {
        ctx.report(nameToken, `${resolved.table.name} has no column ${nameToken.v}`);
      }
    }
  },
};
