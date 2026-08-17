import type { Local } from "../../model/locals.ts";
import type { Rule } from "../rule.ts";
import { assignmentTargets } from "../support.ts";

interface Tally {
  item: Local;
  reads: number;
  writes: number;
}

export const unusedVariable: Rule = {
  id: "routine/unused-variable",
  group: "routine",
  severity: "hint",
  scope: "document",
  docs: `A \`DECLARE\` variable nobody reads.

Two cases, and they get different wording because they mean different things:

  - **Never mentioned again.** A leftover from an earlier edit. Dead weight, nothing more.
  - **Assigned and never read.** More interesting. A \`SELECT … INTO v\` that fetches a value and
    throws it away is usually a check somebody meant to write and did not.

Only variables. A parameter is part of the signature, so removing one breaks every caller; a cursor
and a temporary table are used in ways that are not reading a value, and each has its own rule.

**An argument in an \`OUT\` position counts as a read**, deliberately, so a variable that exists only
to absorb one stays quiet. MySQL demands a variable there whether the value is wanted or not, so it
cannot be removed — and this rule's whole claim is that what it points at is surplus. Tagged
\`unnecessary\`, which greys the name out in an editor, so pointing at a name its author cannot delete
would be worse than saying nothing.

A **hint**: dead code is not a bug. It changes no result and breaks nothing.

Where the same name is declared in two routines of one file, the tally is shared and any use counts
for both. That under-reports, which is the right direction to be wrong in.`,

  check(ctx) {
    const declared = new Map<string, Tally>();
    const order: string[] = [];
    for (const item of ctx.locals.items) {
      if (item.kind !== "variable") continue;
      const key = ctx.dialect.foldIdentifier(item.name, item.quoted);
      if (!declared.has(key)) order.push(key);
      // The last declaration is the one pointed at, so a name declared twice is reported once.
      declared.set(key, { item, reads: 0, writes: 0 });
    }
    if (order.length === 0) return;

    // Only `written` is used: `callOuts` is left counting as a read, which is the exemption above.
    const { written } = assignmentTargets(ctx);

    ctx.tokens.forEach((t, i) => {
      if (t.t !== "id" || t.q) return;
      const entry = declared.get(ctx.dialect.foldIdentifier(t.v, false));
      // The `DECLARE` itself is not a use, and is recognised by its offset.
      if (!entry || t.s === entry.item.nameSpan.s) return;
      if (written.has(i)) entry.writes++;
      else entry.reads++;
    });

    for (const key of order) {
      const entry = declared.get(key)!;
      if (entry.reads > 0) continue;
      const message =
        entry.writes === 0
          ? `unused variable: ${entry.item.name}`
          : `${entry.item.name} is assigned but never read`;
      ctx.report(entry.item.nameSpan, message, ["unnecessary"]);
    }
  },
};
