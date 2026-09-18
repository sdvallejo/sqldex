import { taintedReads } from "../shared/null-guard.ts";
import type { Rule } from "../rule.ts";

export const nullableVariableInConcat: Rule = {
  id: "routine/nullable-variable-in-concat",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A nullable column reaching a \`CONCAT\` through a variable.

**\`CONCAT\` spreads a NULL rather than skipping it.** One NULL argument and the *whole string* is
NULL — not that argument missing from it, the entire result gone — which is how an error message, a
log line, a key, or a whole \`PREPARE\`d statement turns into nothing at all, with no error anywhere.
\`CONCAT_WS\` skips NULLs, and is not reported.

The taint is the one \`routine/nullable-into-arithmetic\` uses, computed once and shared: a variable is
suspect only where a \`SELECT … INTO\` filled it, by position, from a column the **catalog** says is
nullable. That is what separates this from guessing about variables — nothing in the file itself
knows that \`SELECT closed_at INTO v_closed\` may have left a variable holding nothing. The same taint
reaching a negated comparison is \`routine/nullable-variable-in-predicate\`.

What it deliberately leaves alone:

  - **A read already wrapped** in \`COALESCE\` or \`IFNULL\`, and the innermost wrapper is the one
    that counts: \`CONCAT('x', COALESCE(v, ''))\` is the fix, not the defect.
  - **A statement that asks about the NULL itself.** One \`IS NULL\` or \`IS NOT NULL\` about the
    variable anywhere in the statement is taken as somebody having thought about it.
  - **An \`IF\` arm that is only reached after asking.** Inside \`IF v IS NOT NULL THEN … END IF\`,
    and in every arm after an \`ELSEIF v IS NULL THEN\` that did not run, the code already knows. The
    convention is the statement one, widened to the \`IF\` chain around the statement, and it costs
    the same thing: an arm that asked and got *yes* — \`IF v IS NULL THEN … CONCAT('x', v)\` — is left
    alone too, because telling which arm knows which answer is a parse this backend does not do, and
    being wrong about it would mean arguing with the author's own guard.

**What it does not model**, and this it shares with the arithmetic rule: a later assignment from a
source that cannot be NULL does not clear the taint. That needs flow analysis this backend does not
do, and the exchange is worth naming — it can be wrong about a variable that was tainted and then
fixed, and in return it is never wrong about what tainted it.`,

  check(ctx) {
    for (const { token, origin, wrapper } of taintedReads(ctx)) {
      if (wrapper !== "concat") continue;
      ctx.report(token, `${token.v} comes from ${origin}, which is nullable; one NULL argument makes the whole CONCAT NULL`);
    }
  },
};
