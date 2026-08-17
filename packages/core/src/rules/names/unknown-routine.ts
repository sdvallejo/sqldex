import { qualifiedName } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const unknownRoutine: Rule = {
  id: "names/unknown-routine",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A \`CALL\` to a procedure the catalog does not have.

The same claim as \`names/unknown-table\`, for the other kind of name a repo of stored procedures is
full of. A \`CALL\` to a name nothing defines fails every time it runs, so what this catches in
practice is a rename that missed one of its callers.

It says nothing about the arguments — \`routine/call-arity\` does that, and only once the routine is
known, since a signature is what the count is compared against.`,

  check(ctx) {
    for (const call of ctx.calls) {
      const { name, nameToken } = qualifiedName(ctx.tokens, call + 1);
      if (!name || !nameToken) continue;
      if (ctx.catalog.routine(name)) continue;
      ctx.report(nameToken, `unknown routine: ${name}`);
    }
  },
};
