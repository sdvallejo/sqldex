import { auditTableName } from "../../analysis/audit.ts";
import type { Rule } from "../rule.ts";

export const auditTableOutOfSync: Rule = {
  id: "audit/table-out-of-sync",
  group: "audit",
  // Both would report the column's name. A column missing from the `aud_` twin is the concrete
  // fact; that its type is an outlier is a statement about the rest of the schema.
  supersedes: ["schema/divergent-type"],
  severity: "warn",
  scope: "table",
  docs: `A column of this table that its \`aud_\` twin does not have.

Where the twin exists, it is supposed to mirror the table. A column added to one and not the other
is the drift this catches, and it is invisible until somebody queries the mirror.

**The wording is deliberately narrow, and measuring is what narrowed it.** An earlier version said
the column "is not being audited", which is not always true: the triggers insert **positionally**, so
a column whose mirror is merely *named* differently does have its value stored. The claim the rule
can defend is the one it makes — the twin has no column by that name, so anyone selecting it gets an
error. Whether data is actually being lost is \`audit/trigger-missing-column\`'s question, and it can
tell.

**Generated columns are not excluded**, tempting though it is on the grounds that they are derived.
Audited tables do carry their generated columns in the twin, so skipping them would let a real drift
through.

Silent where the convention is not in use: no \`aud_\` twin, nothing to compare.`,

  check(ctx) {
    const audit = ctx.catalog.table(auditTableName(ctx.table.name));
    if (!audit) return;

    for (const column of ctx.table.columns) {
      if (audit.byName.has(ctx.dialect.foldIdentifier(column.name, column.quoted))) continue;
      ctx.report(column.nameSpan, `audit table ${audit.name} has no column ${column.name}`);
    }
  },
};
