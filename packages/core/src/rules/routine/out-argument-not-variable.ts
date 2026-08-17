import { isKeyword } from "../../dialects/mysql/index.ts";
import { matchingParen, punct, qualifiedName, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";
import { arity } from "./call-arity.ts";

/**
 * Can the engine write to this argument?
 *
 * A literal, an expression or a qualified name is a definite error. **A bare identifier the analysis
 * does not recognise is left alone**, deliberately: far likelier to be a scope this missed than a
 * real defect, and this rule reports errors.
 *
 * `NULL`, `TRUE` and `DEFAULT` lex as identifiers but cannot be written to. A variable genuinely
 * named after a keyword has to be delimited, which is what `q` records.
 */
function isAssignable(tokens: readonly Token[], span: TokenRange): boolean {
  if (span.from !== span.to) return false;
  const t = tokens[span.from]!;
  if (t.t !== "id") return false;
  return t.q === true || !isKeyword(t.v);
}

export const outArgumentNotVariable: Rule = {
  id: "routine/out-argument-not-variable",
  group: "routine",
  severity: "error",
  scope: "statement",
  docs: `An argument in an \`OUT\`/\`INOUT\` position that the engine cannot write to.

MySQL error 1414: *OUT or INOUT argument N for routine X is not a variable*. The catalog has every
signature with its parameter modes, so this is decidable rather than a suspicion — which is why it is
an error.

Expect it to find nothing on a schema that has been in production, and that is the *right* result:
the call fails every single time it runs, so any such mistake was removed the first time that branch
executed. The value is entirely in catching it while it is being typed.

It stands down when the argument count does not match the signature: with the wrong count the slots
no longer line up with the parameters, so checking which of them the callee writes would be comparing
the wrong things.`,

  check(ctx) {
    for (const call of ctx.calls) {
      const { name, nextIdx } = qualifiedName(ctx.tokens, call + 1);
      if (!name) continue;
      const routine = ctx.catalog.routine(name);
      if (!routine || !punct(ctx.tokens[nextIdx], "(")) continue;

      // Both preconditions checked here rather than left to rule order.
      const given = arity(ctx.tokens, nextIdx);
      if (!given || given.count !== routine.params.length) continue;

      const close = matchingParen(ctx.tokens, nextIdx);
      if (close === -1 || close <= nextIdx + 1) continue;

      splitCommas(ctx.tokens, nextIdx + 1, close - 1).forEach((span, slot) => {
        const param = routine.params[slot];
        if (!param || param.mode === "IN" || isAssignable(ctx.tokens, span)) return;
        ctx.report(
          { s: ctx.tokens[span.from]!.s, e: ctx.tokens[span.to]!.e },
          `argument ${slot + 1} of ${routine.name} is ${param.mode} and must be a variable`,
        );
      });
    }
  },
};
