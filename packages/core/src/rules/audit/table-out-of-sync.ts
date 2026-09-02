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

**A column all three sides agree about is not drift.** Where the twin has no column for it *and* none
of the table's audit triggers tries to copy it, the table, the twin and the triggers are saying the
same thing — this one is not audited — and that is a decision somebody made, most often about a
secret nobody wants a second copy of. Drift is the sides **disagreeing**: a twin missing a column a
trigger is still writing, or a table with no audit triggers at all to consult. Both of those are
still reported, which is what keeps this from being a way to silence the rule by deleting a line
from a trigger.

Silent where the convention is not in use: no \`aud_\` twin, nothing to compare.`,

  check(ctx) {
    const audit = ctx.catalog.table(auditTableName(ctx.table.name));
    if (!audit) return;

    const own = ctx.dialect.foldIdentifier(ctx.table.name, ctx.table.quoted);
    const auditTriggers = [...ctx.catalog.triggers.values()].filter(
      (trigger) =>
        trigger.audit?.writesAudit === true && ctx.dialect.foldIdentifier(trigger.table, false) === own,
    );

    for (const column of ctx.table.columns) {
      const key = ctx.dialect.foldIdentifier(column.name, column.quoted);
      if (audit.byName.has(key)) continue;
      // All three sides agreeing is a decision, not drift: the twin has no column for it and no
      // trigger tries to copy it either.
      if (auditTriggers.length > 0 && auditTriggers.every((trigger) => !trigger.audit!.columns.has(key))) {
        continue;
      }
      ctx.report(column.nameSpan, `audit table ${audit.name} has no column ${column.name}`);
    }
  },
};
