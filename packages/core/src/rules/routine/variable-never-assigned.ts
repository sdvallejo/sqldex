import type { Local } from "../../model/locals.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";
import { assignmentTargets, insideNullSafe } from "../support.ts";

interface Tally {
  item: Local;
  reads: Token[];
  written: boolean;
}

export const variableNeverAssigned: Rule = {
  id: "routine/variable-never-assigned",
  group: "routine",
  // The stronger claim about the same read: this one says it cannot be anything but NULL, where the
  // taint rule says it might be.
  supersedes: ["routine/nullable-into-arithmetic"],
  severity: "warn",
  scope: "routine",
  docs: `A variable read when it can only hold NULL.

A \`DECLARE\` with no \`DEFAULT\` starts as NULL. If nothing ever assigns it, every read is a read of
NULL — and NULL does not announce itself. It makes a comparison neither true nor false, so the branch
around it quietly takes the wrong path: \`WHERE col = v\` matches nothing, \`NOT EXISTS(… WHERE col =
v)\` is always true, and the code appears to work for years.

**Only variables nothing assigns anywhere are reported.** The obvious extension — flagging a read
that sits above the first write — is deliberately left out. Most such reads are in a file with a
loop, where a read above a write runs *after* it on the second pass, so deciding them needs real flow
analysis. Guessing would put this rule's warnings in the same bucket as its noise, and the whole
value of this one is that it is right.

**A read wrapped in \`COALESCE\` / \`IFNULL\` / \`IF\` does not count.** Reading a NULL is only a defect
if the NULL escapes; a body that declares variables it never sets and wraps every read is
deliberate, and correct.

An \`OUT\` argument of a \`CALL\` counts as a write, because the callee fills it in — so what follows is
not a read of NULL.

Reported on the **first unprotected read**, not on the \`DECLARE\`: that is where the wrong answer is
produced, and the declaration on its own looks perfectly fine.

Parameters are excluded: an \`IN\` parameter is initialised by the caller, and an \`OUT\` one is *meant*
to start empty.`,

  check(ctx) {
    const declared = new Map<string, Tally>();
    const order: string[] = [];
    for (const item of ctx.locals.items) {
      if (item.kind !== "variable" || item.default) continue;
      const key = ctx.dialect.foldIdentifier(item.name, item.quoted);
      if (!declared.has(key)) order.push(key);
      declared.set(key, { item, reads: [], written: false });
    }
    if (order.length === 0) return;

    const { written, callOuts } = assignmentTargets(ctx);

    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      if (t.t !== "id" || t.q) return;
      const entry = declared.get(ctx.dialect.foldIdentifier(t.v, false));
      if (!entry || t.s === entry.item.nameSpan.s) return;
      if (written.has(i) || callOuts.has(i)) entry.written = true;
      else if (!insideNullSafe(ctx.tokens, i)) entry.reads.push(t);
    });

    for (const key of order) {
      const entry = declared.get(key)!;
      if (entry.written || entry.reads.length === 0) continue;
      ctx.report(entry.reads[0]!, `${entry.item.name} is never assigned, so this reads NULL`);
    }
  },
};
