import { kw, kwAny, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/** What a label can be attached to: the four constructs MySQL lets one name. */
const LABELLED: ReadonlySet<string> = new Set(["BEGIN", "LOOP", "WHILE", "REPEAT"]);

export const unknownLabel: Rule = {
  id: "routine/unknown-label",
  group: "routine",
  severity: "error",
  scope: "routine",
  docs: `A \`LEAVE\` or \`ITERATE\` naming a label that no block declares.

\`LEAVE\` and \`ITERATE\` are the only two statements in procedural MySQL that jump, and both name
their destination. A destination that does not exist is not a runtime surprise: the routine does not
parse, error 1308, and the \`CREATE PROCEDURE\` fails. The procedure that was already on the server
stays there, so what breaks is the deploy.

It is what a renamed loop leaves behind. A label is written twice — once at \`wheel: LOOP\` and once
at \`END LOOP wheel\` — and read a third time by every \`LEAVE\` inside it, so renaming one of them and
not the others is ordinary, and nothing complains until the file is applied.

Labels fold case like every other identifier, which is checked rather than assumed:
\`Wheel: LOOP … LEAVE WHEEL\` is one label, not two, and reading them as two would report the routine
that works.

**Only the existence of the label is checked, not whether it encloses the jump.** MySQL wants the
label on a block the statement is actually inside, and refuses a \`LEAVE\` aimed at a sibling loop
with the same error — but deciding that means tracking which blocks are open at each point, which is
flow analysis this backend does not do. A label declared anywhere in the routine is therefore taken
as reachable: the rule reports the jump that names nothing at all, which is the one that can be
decided by reading.`,

  check(ctx) {
    const { tokens } = ctx;
    const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);

    const labels = new Set<string>();
    for (let i = ctx.body.from; i <= ctx.body.to; i++) {
      const t = tokens[i]!;
      // `wheel: LOOP`. The `:` is its own token — `:=` lexes whole — so this cannot read a user
      // variable's assignment as a declaration.
      if (t.t !== "id" || t.q) continue;
      if (punct(tokens[i + 1], ":") && kwAny(tokens[i + 2], LABELLED) !== undefined) labels.add(fold(t.v));
    }

    for (let i = ctx.body.from; i <= ctx.body.to; i++) {
      const verb = kw(tokens[i], "LEAVE") ? "LEAVE" : kw(tokens[i], "ITERATE") ? "ITERATE" : undefined;
      if (verb === undefined) continue;
      const target = tokens[i + 1];
      if (target?.t !== "id" || target.q) continue;
      if (labels.has(fold(target.v))) continue;
      ctx.report(target, `${verb} ${target.v}: no block in ${ctx.routine.name} is labelled ${target.v}`);
    }
  },
};
