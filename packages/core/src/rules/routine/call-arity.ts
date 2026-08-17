import { matchingParen, punct, qualifiedName, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Depth-zero comma-separated items inside a parenthesis: tells `f()` — zero — from `f(x)` — one. */
export function arity(tokens: readonly Token[], openIdx: number): { count: number; close: number } | undefined {
  const close = matchingParen(tokens, openIdx);
  if (close === -1) return undefined;
  if (close === openIdx + 1) return { count: 0, close };
  return { count: splitCommas(tokens, openIdx + 1, close - 1).length, close };
}

export const callArity: Rule = {
  id: "routine/call-arity",
  group: "routine",
  severity: "error",
  scope: "statement",
  docs: `A \`CALL\` whose argument count does not match the procedure's signature.

An error, not a suspicion: the engine rejects it at execution time, and every signature is already in
the catalog with its parameters. There is nothing to weigh up.

\`CALL p;\` with no parentheses at all is valid — but only for a procedure that takes no parameters, so
it is reported when the signature has some.

Nothing is said when the procedure is not in the catalog: there is no signature to count against, and
\`names/unknown-routine\` has already said the useful thing about that line.`,

  check(ctx) {
    for (const call of ctx.calls) {
      const { name, nextIdx, nameToken } = qualifiedName(ctx.tokens, call + 1);
      if (!name || !nameToken) continue;

      const routine = ctx.catalog.routine(name);
      if (!routine) continue;

      const expected = routine.params.length;
      if (!punct(ctx.tokens[nextIdx], "(")) {
        if (expected > 0) {
          ctx.report(nameToken, `${routine.name} expects ${expected} argument(s) and is called with none`);
        }
        continue;
      }

      const given = arity(ctx.tokens, nextIdx);
      if (given && given.count !== expected) {
        ctx.report(nameToken, `${routine.name} expects ${expected} argument(s) and gets ${given.count}`);
      }
    }
  },
};
