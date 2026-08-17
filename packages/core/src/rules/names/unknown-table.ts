import type { Rule } from "../rule.ts";
import { BUILTIN_NAMES, SYSTEM_SCHEMAS } from "../support.ts";

export const unknownTable: Rule = {
  id: "names/unknown-table",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A relation the catalog does not have.

The plainest thing this engine can say, and the reason it builds a catalog at all: a \`FROM\` naming
something no file in the repo defines.

Four kinds of name are not reported, and each is a name that was never going to be in the catalog:

  - **A derived table**, which has no name to check.
  - **A reference into another schema** — \`information_schema.tables\`, or another database of the
    same server. Those tables are not this repo's to define.
  - **A common table expression.** The statement defines it, and nothing puts it in a catalog.
  - **A temporary table**, whether this file creates it or another one does. That last part matters
    more than it sounds: the ordinary pattern is one procedure creating a temporary table and
    another querying it after a \`CALL\`, so a per-file view of them would flag most of the second
    procedure. On a procedure-heavy schema that single cause accounts for most of the noise a rule
    like this can produce.

\`DUAL\` and the \`NEW\`/\`OLD\` of a trigger are excluded too: they are the engine's, not the schema's.`,

  check(ctx) {
    for (const relation of ctx.relations) {
      if (!relation.name || relation.cte) continue;
      if (relation.schema && SYSTEM_SCHEMAS.has(relation.schema.toLowerCase())) continue;
      // A schema-qualified name of a schema this repo *does* define is still not looked up here:
      // the original leaves every qualified reference to the qualified-name rule.
      if (relation.schema) continue;

      const key = ctx.dialect.foldIdentifier(relation.name, relation.quoted === true);
      if (BUILTIN_NAMES.has(key)) continue;

      const local = ctx.locals.byName.get(key);
      if (local?.kind === "temp_table" || ctx.catalog.tempTable(relation.name)) continue;
      if (ctx.catalog.table(relation.name)) continue;

      ctx.report(
        relation.nameSpan ?? { s: relation.offset, e: relation.offset + relation.name.length },
        `unknown table: ${relation.name}`,
      );
    }
  },
};
