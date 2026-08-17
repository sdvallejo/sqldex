import { kw } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";
import { auditTableName } from "./convention.ts";

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

**The guard is what makes the rule mean anything:** only triggers that actually insert into
\`aud_<table>\` are checked. Without it the rule reads as "every trigger must mention every column",
which is nonsense for a trigger that exists to enforce a business rule.

One diagnostic per trigger, listing the columns it misses, reported on the trigger's name — because
the thing you go and fix is the trigger, once, not each column in turn.`,

  check(ctx) {
    const table = ctx.catalog.table(ctx.trigger.table);
    if (!table) return;

    const target = ctx.dialect.foldIdentifier(auditTableName(ctx.trigger.table), false);
    const audited = new Set<string>();
    let writesAudit = false;

    for (let i = ctx.trigger.body.from; i <= ctx.trigger.body.to; i++) {
      const t = ctx.tokens[i];
      if (!t) break;
      if (t.t === "punct" && t.v === ".") {
        const qualifier = ctx.tokens[i - 1];
        const name = ctx.tokens[i + 1];
        if (qualifier && name?.t === "id") {
          const which = qualifier.v.toUpperCase();
          if (which === "NEW" || which === "OLD") {
            audited.add(ctx.dialect.foldIdentifier(name.v, name.q ?? false));
          }
        }
      } else if (kw(t, "INTO")) {
        const into = ctx.tokens[i + 1];
        if (into && ctx.dialect.foldIdentifier(into.v, into.q ?? false) === target) writesAudit = true;
      }
    }

    if (!writesAudit) return;

    const missing = table.columns
      .filter((c) => !audited.has(ctx.dialect.foldIdentifier(c.name, c.quoted)))
      .map((c) => c.name);
    if (missing.length === 0) return;

    ctx.report(ctx.trigger.nameSpan, `${ctx.trigger.name} does not audit ${missing.join(", ")}`);
  },
};
