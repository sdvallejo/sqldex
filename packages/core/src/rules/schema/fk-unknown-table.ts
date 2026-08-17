import type { Rule } from "../rule.ts";
import { SYSTEM_SCHEMAS } from "../support.ts";

/** `foreign key <name>` or just `foreign key`, for a message that can name what it is talking about. */
export function fkLabel(name: string | undefined): string {
  return name ? `foreign key ${name}` : "foreign key";
}

export const fkUnknownTable: Rule = {
  id: "schema/fk-unknown-table",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `A foreign key pointing at a table that is not in the schema.

An error rather than a warning, because it is not arguable: the engine refuses the constraint
outright. It is also the cheapest rule here and the one most likely to find nothing for a long
time — which is the point. It earns its keep the first time somebody renames a table and misses one
of the keys aimed at it.

References into a schema the engine itself owns (\`information_schema\`, \`mysql\`, \`sys\`,
\`performance_schema\`) are not checked: those tables were never going to be in an application's
repo, so their absence says nothing.

Reported only where the span of the referenced name is known. A range worked out from the name's
length instead would be off by the delimiters whenever the name was quoted, and an underline in the
wrong place is worse than none.`,

  check(ctx) {
    for (const fk of ctx.table.foreignKeys) {
      if (!fk.refTable || !fk.refTableSpan) continue;
      if (SYSTEM_SCHEMAS.has(fk.refTable.toLowerCase())) continue;
      if (ctx.catalog.table(fk.refTable)) continue;
      ctx.report(fk.refTableSpan, `${fkLabel(fk.name)} points at an unknown table: ${fk.refTable}`);
    }
  },
};
