import type { Rule } from "../rule.ts";
import { SYSTEM_SCHEMAS } from "../support.ts";

export const fkUnknownColumn: Rule = {
  id: "schema/fk-unknown-column",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `A foreign key naming a column that does not exist — on either end of it.

Both ends are checked, because a key can dangle in two directions and they are different mistakes:
one of its **own** columns may not exist in the table declaring it, or one of the **referenced**
columns may not exist in the target. The engine rejects either, which is why this is an error.

Each name is reported where it was written, not on the constraint as a whole. Pointing at the whole
\`FOREIGN KEY (...) REFERENCES ...(...)\` would say which key is wrong and leave you to find which of
its four columns it meant.

Nothing is said about the target's columns when the target itself is missing: \`schema/fk-unknown-table\`
has already said the useful thing, and two complaints about one line read as two problems.`,

  check(ctx) {
    for (const fk of ctx.table.foreignKeys) {
      // Its own columns, which have to exist in the table declaring the key.
      fk.columns.forEach((name, position) => {
        const span = fk.columnSpans[position];
        if (span && !ctx.table.byName.get(ctx.dialect.foldIdentifier(name, false))) {
          ctx.report(span, `${ctx.table.name} has no column ${name}`);
        }
      });

      if (!fk.refTable || SYSTEM_SCHEMAS.has(fk.refTable.toLowerCase())) continue;
      const target = ctx.catalog.table(fk.refTable);
      if (!target) continue;

      fk.refColumns.forEach((name, position) => {
        const span = fk.refColumnSpans[position];
        if (span && !target.byName.get(ctx.dialect.foldIdentifier(name, false))) {
          ctx.report(span, `${target.name} has no column ${name}`);
        }
      });
    }
  },
};
