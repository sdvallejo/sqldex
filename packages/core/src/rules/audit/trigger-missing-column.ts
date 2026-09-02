import { auditTableName, triggerAudit } from "../../analysis/audit.ts";
import type { Rule } from "../rule.ts";

export const auditTriggerMissingColumn: Rule = {
  id: "audit/trigger-missing-column",
  group: "audit",
  severity: "warn",
  scope: "trigger",
  docs: `An audit trigger that does not copy every one of its table's columns.

The triggers insert positionally — \`INSERT INTO aud_orders VALUES (0, NOW(), ..., NEW.status, ...)\` —
so a column is audited exactly when it appears as \`NEW.col\` or \`OLD.col\` somewhere in the body.
\`NEW\` and \`OLD\` are collected together on purpose: the \`AFTER UPDATE\` trigger writes two rows, the
before state with \`OLD.\` and the after state with \`NEW.\`, and either mention proves the column is
carried.

Unlike \`audit/table-out-of-sync\`, this one can say data is being lost: the column exists on both
sides and the trigger simply never reads it.

**Two guards, and each is what makes the rule mean anything.** Only triggers that actually insert
into \`aud_<table>\` are checked — without that the rule reads as "every trigger must mention every
column", which is nonsense for a trigger that exists to enforce a business rule. And only columns the
twin actually has are asked for: where the twin has no column to put a value in, a trigger copying it
would have nowhere to write, so reporting it asks for something that cannot be done. That case is
\`audit/table-out-of-sync\`'s to judge, and it has its own reason to stay quiet about a column all
three sides agree is not audited.

One diagnostic per trigger, listing the columns it misses, reported on the trigger's name — because
the thing you go and fix is the trigger, once, not each column in turn.`,

  check(ctx) {
    const table = ctx.catalog.table(ctx.trigger.table);
    if (!table) return;
    const twin = ctx.catalog.table(auditTableName(ctx.trigger.table));
    if (!twin) return;

    const { columns: audited, writesAudit } = triggerAudit(ctx.dialect, ctx.tokens, ctx.trigger);
    if (!writesAudit) return;

    const missing = table.columns
      .filter((c) => {
        const key = ctx.dialect.foldIdentifier(c.name, c.quoted);
        return twin.byName.has(key) && !audited.has(key);
      })
      .map((c) => c.name);
    if (missing.length === 0) return;

    ctx.report(ctx.trigger.nameSpan, `${ctx.trigger.name} does not audit ${missing.join(", ")}`);
  },
};
