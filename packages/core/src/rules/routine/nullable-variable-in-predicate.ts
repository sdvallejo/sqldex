import { taintedReads } from "../shared/null-guard.ts";
import { kw } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/**
 * The comparisons where a NULL answers the opposite of what the person reading it would.
 *
 * **Only the negated ones, and that is the whole of the argument.** `v = 'A'` coming out false for a
 * NULL agrees with every reader: it is not 'A'. `v != 'A'` is where the two part company — a NULL is
 * not 'A' by any reading a person gives that line, and MySQL still says no. Reporting `=` as well
 * meant reporting the ordinary shape of every procedure in the repo; this is the shape where the
 * code says one thing and the engine does another.
 */
const NEGATIONS: ReadonlySet<string> = new Set(["!=", "<>"]);

/** The same, written as words, each of which arrives after a `NOT`. */
const NEGATED_WORDS: ReadonlySet<string> = new Set(["IN", "LIKE", "BETWEEN", "REGEXP", "RLIKE"]);

/** Is this read an operand of a negated comparison, on either side of it? */
function negated(tokens: readonly Token[], idx: number): string | undefined {
  for (const at of [idx - 1, idx + 1] as const) {
    const t = tokens[at];
    if (t?.t === "punct" && NEGATIONS.has(t.v)) return t.v;
  }
  // `v NOT IN (…)`, `v NOT LIKE …`, `v NOT BETWEEN a AND b`.
  const word = tokens[idx + 2];
  if (kw(tokens[idx + 1], "NOT") && word?.t === "id" && NEGATED_WORDS.has(word.v.toUpperCase())) {
    return `NOT ${word.v.toUpperCase()}`;
  }
  return undefined;
}

export const nullableVariableInPredicate: Rule = {
  id: "routine/nullable-variable-in-predicate",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A nullable column reaching a **negated** comparison through a variable.

The third place a taint from \`SELECT col INTO v\` escapes, after arithmetic: **a NULL is not
"different from" anything, and MySQL still says no.** This is the whole reason the rule looks at
\`!=\` and not at \`=\`: \`v = 'A'\` coming out false for a NULL agrees with every reader — it is not
'A'. \`v != 'A'\` is where the code and the engine part company, because a NULL is not 'A' by any
reading a person gives that line, and the comparison is still unknown, and unknown reads as false.
\`IF v != 'A' THEN raise\` does not raise; \`WHERE t.c != v\` returns nothing. \`NOT IN\`, \`NOT LIKE\`,
\`NOT BETWEEN\` and \`NOT REGEXP\` are the same comparison spelled with a word.

The taint is the one \`routine/nullable-into-arithmetic\` uses, computed once and shared: a variable is
suspect only where a \`SELECT … INTO\` filled it, by position, from a column the **catalog** says is
nullable. That is what separates this from guessing about variables — nothing in the file itself
knows that \`SELECT closed_at INTO v_closed\` may have left a variable holding nothing. The same taint
reaching a \`CONCAT\` is \`routine/nullable-variable-in-concat\`.

What it deliberately leaves alone:

  - **A statement that asks about the NULL itself.** \`IF v IS NOT NULL AND v != x THEN\` and
    \`… WHERE t.c != v OR v IS NULL\` are both somebody who thought about this, and one \`IS NULL\`
    anywhere in the statement is taken as having handled it. Deciding whether a particular \`OR\`
    covers a particular \`AND\` is a parse this backend does not do, and being wrong about it would
    mean arguing with the author's own guard.
  - **An \`IF\` arm that is only reached after asking.** Inside \`IF v IS NOT NULL THEN … END IF\`,
    and in every arm after an \`ELSEIF v IS NULL THEN\` that did not run, the code already knows. The
    convention is the statement one, widened to the \`IF\` chain around the statement, and it costs
    the same thing: an arm that asked and got *yes* — \`IF v IS NULL THEN … v != x\` — is left alone
    too, because telling which arm knows which answer is the parse this backend does not do.
  - **\`<=>\`**, the NULL-safe equality, which is the operator that exists for exactly this.
  - **A read already wrapped** in \`COALESCE\` or \`IFNULL\`.
  - **\`=\`, \`<\`, \`>\` and the rest**, where unknown-reads-as-false is the same answer the person
    reading the line would give.

**What it does not model**, and this it shares with the arithmetic rule: a later assignment from a
source that cannot be NULL does not clear the taint. That needs flow analysis this backend does not
do, and the exchange is worth naming — it can be wrong about a variable that was tainted and then
fixed, and in return it is never wrong about what tainted it.`,

  check(ctx) {
    for (const { token, index, origin } of taintedReads(ctx)) {
      const how = negated(ctx.tokens, index);
      if (!how) continue;
      ctx.report(
        token,
        `${token.v} comes from ${origin}, which is nullable, and a NULL is not "${how}" anything: ` +
          "MySQL answers unknown, which reads as false",
      );
    }
  },
};
