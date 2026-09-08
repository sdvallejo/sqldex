import { assignmentTargets } from "../shared/writes.ts";
import { kw, matchingParen, punct, qualifiedName, splitCommas } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const outParamNeverAssigned: Rule = {
  id: "routine/out-param-never-assigned",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `An \`OUT\` parameter the body never assigns.

An \`OUT\` parameter is the whole of what a procedure gives back to a \`CALL\`. MySQL does not hand
the callee whatever the caller's variable held: it starts the parameter at NULL, runs the body, and
copies the parameter back on the way out. So a body that never assigns one returns NULL to the
caller, every time, whatever the caller had in that variable beforehand — confirmed against a live
server rather than assumed: a variable holding 42, passed to a procedure that never touches its
\`OUT\` parameter, comes back NULL.

That NULL then behaves like every other NULL: the caller's \`IF result = 1\` is neither true nor
false and the branch silently takes the other path. The routine reports success and returns nothing.

**\`INOUT\` is deliberately not reported**, and the same check against the server is why: an \`INOUT\`
parameter is copied *in* as well as out, so a body that never assigns it returns the caller's own
value unchanged. That is a procedure that decided not to change anything, which is not a defect.

Every way a body can fill a parameter counts as an assignment: \`SET\`, \`SELECT … INTO\`,
\`FETCH … INTO\`, \`GET DIAGNOSTICS\`, and an \`OUT\` argument of a nested \`CALL\` — the last of which is
looked up in the callee's signature, so which argument that is comes from the catalog rather than
from a guess.

**A \`CALL\` the catalog cannot resolve silences the parameter it names.** Which argument of a call is
\`OUT\` is the callee's signature, so a procedure this repo does not hold — one in another database,
or one nobody exported — leaves the question undecidable, and the rule stands down rather than
accusing the caller of not filling something the callee fills.

**A parameter shadowed by a \`DECLARE\` of the same name is left to
\`routine/shadowed-parameter\`.** There the assignments are real and simply land on the wrong cell,
which is a different sentence about the same file; reporting both would be two findings for one
edit.

Reported on the routine's name, because that is where the header declaring the parameter is: the
model gives a parameter the routine's own span, and there is no single place in the body to point at
for something the body never does.`,

  check(ctx) {
    const outs = ctx.routine.params.filter((param) => param.mode === "OUT");
    if (outs.length === 0) return;

    const fold = (name: string, quoted: boolean): string => ctx.dialect.foldIdentifier(name, quoted);
    const shadowed = new Set<string>();
    for (const item of ctx.locals.items) {
      if (item.kind === "variable") shadowed.add(fold(item.name, item.quoted));
    }

    const wanted = new Map<string, string>();
    for (const param of outs) {
      const key = fold(param.name, param.quoted);
      if (!shadowed.has(key)) wanted.set(key, param.name);
    }
    if (wanted.size === 0) return;

    const { written, callOuts } = assignmentTargets(ctx);
    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's parameters are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      if (t.t !== "id") return;
      if (written.has(i) || callOuts.has(i)) wanted.delete(fold(t.v, t.q === true));
    });

    // A `CALL` the catalog cannot resolve may be the thing that fills it: which of its arguments is
    // `OUT` lives in the callee's signature, and without that there is no claim to make about any of
    // them. A routine in another database, or one this repo does not hold, lands here.
    for (let i = ctx.body.from; i <= ctx.body.to; i++) {
      if (!kw(ctx.tokens[i], "CALL")) continue;
      const called = qualifiedName(ctx.tokens, i + 1);
      if (called.name !== undefined && ctx.catalog.routine(called.name) !== undefined) continue;
      if (!punct(ctx.tokens[called.nextIdx], "(")) continue;
      const close = matchingParen(ctx.tokens, called.nextIdx);
      if (close === -1) continue;
      for (const span of splitCommas(ctx.tokens, called.nextIdx + 1, close - 1)) {
        const argument = ctx.tokens[span.from];
        if (span.from === span.to && argument?.t === "id") wanted.delete(fold(argument.v, argument.q === true));
      }
    }

    for (const name of wanted.values()) {
      ctx.report(
        ctx.routine.nameSpan,
        `${name} is an OUT parameter and ${ctx.routine.name} never assigns it, so every caller reads back NULL`,
      );
    }
  },
};
