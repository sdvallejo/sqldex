import type { Rule } from "../rule.ts";

export const noPrimaryKey: Rule = {
  id: "schema/no-primary-key",
  group: "schema",
  severity: "hint",
  scope: "table",
  docs: `A table with no \`PRIMARY KEY\`.

InnoDB gives such a table a hidden key of its own, so nothing is broken — but nothing can address a
row either. Replication, \`ON DUPLICATE KEY\`, a foreign key aimed at it and any tooling that expects
to identify a row all have nothing to work with.

A **hint**, and the reason is what turns up when you look: tables without a primary key are, in
practice, auxiliary and migration tables — scratch space that is filled, read once and dropped, where
a key would be ceremony. As an error this rule would be noise about work that is already finished. As
a suggestion it is worth having, because the one table in the set that is *not* scratch space is a
real problem.

Temporary tables are never reported: they exist for the length of one procedure, which is the case
the hint would be wrong about every time.`,

  check(ctx) {
    if (ctx.table.primaryKey.length > 0) return;
    ctx.report(ctx.table.nameSpan, `${ctx.table.name} has no primary key`);
  },
};
