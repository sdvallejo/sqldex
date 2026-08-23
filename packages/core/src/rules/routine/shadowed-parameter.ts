import type { Local } from "../../model/locals.ts";
import type { Rule } from "../rule.ts";

export const shadowedParameter: Rule = {
  id: "routine/shadowed-parameter",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A \`DECLARE\` that reuses one of the routine's own parameter names.

MySQL does not reject this at \`CREATE\`. The \`DECLARE\` opens a variable of its own, and from that
point on anyone who spells the name is talking to it and not to the parameter — which is still
there, just unreachable under its own name for the rest of the block.

For an \`IN\` parameter that means every read after the \`DECLARE\` sees the local's own value (NULL,
or whatever \`DEFAULT\` says) instead of what the caller passed in. For \`OUT\` and \`INOUT\` it is
worse: MySQL copies the *parameter's* value back to the caller when the routine returns, and the
\`DECLARE\`'d variable is a different cell that is never copied anywhere. A \`SET\` that means to fill
the output fills the local instead, and the caller reads back whatever the parameter held on the way
in — NULL, for an \`OUT\`.

Confirmed against a live server rather than assumed: neither shape raises an error. \`CREATE\`
succeeds, \`CALL\` succeeds, and the value that comes back is simply the wrong one.

A **warn**: the routine still runs and still returns a value, so this is not the parse-time failure
\`routine/declare-after-statement\` catches. It is the same class as \`routine/out-argument-not-variable\`
— a shape that looks like it moves a value and does not.

Only reported where the shadow is read or written again. A \`DECLARE\` that reuses a parameter's name
and is never mentioned afterward has not moved a wrong value anywhere yet — \`routine/unused-variable\`
already says that one is dead, and saying it twice about a defect that has not happened would be
noise on top of a correct answer.`,

  check(ctx) {
    const params = new Map<string, string>();
    for (const item of ctx.locals.items) {
      if (item.kind !== "param") continue;
      const key = ctx.dialect.foldIdentifier(item.name, item.quoted);
      if (!params.has(key)) params.set(key, item.name);
    }
    if (params.size === 0) return;

    const shadows = new Map<string, Local>();
    for (const item of ctx.locals.items) {
      if (item.kind !== "variable") continue;
      const key = ctx.dialect.foldIdentifier(item.name, item.quoted);
      // The last DECLARE of a name is the one that lives at the end of the body, matching how
      // `routine/unused-variable` picks which declaration a repeated name is reported on.
      if (params.has(key)) shadows.set(key, item);
    }
    if (shadows.size === 0) return;

    const touched = new Set<string>();
    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      if (t.t !== "id" || t.q) return;
      const key = ctx.dialect.foldIdentifier(t.v, false);
      const entry = shadows.get(key);
      // The `DECLARE` itself is not a use, and is recognised by its offset.
      if (!entry || t.s === entry.nameSpan.s) return;
      touched.add(key);
    });

    for (const [key, item] of shadows) {
      if (!touched.has(key)) continue;
      const paramName = params.get(key)!;
      ctx.report(
        item.nameSpan,
        `${item.name} shadows the parameter ${paramName}: this DECLARE creates a new variable, so the parameter's value is unreachable under this name for the rest of the block`,
      );
    }
  },
};
