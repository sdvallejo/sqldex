import { nullableSources } from "../shared/taint.ts";
import { assignmentTargets } from "../shared/writes.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { BaseContext, Rule } from "../rule.ts";
import type { TokenRange } from "../../syntax/types.ts";

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

/** What absorbs the NULL before it reaches the comparison, and is therefore the fix. */
const ABSORBING: ReadonlySet<string> = new Set(["COALESCE", "IFNULL"]);

/**
 * The nearest enclosing function call, walking outwards, that has an opinion about a NULL.
 *
 * `CONCAT` is here for the opposite reason to the others: it does not absorb a NULL, it spreads one.
 * One NULL argument and the whole string is NULL — not the argument left out, not an empty string,
 * the entire result — so a tainted variable reaching one is the same defect wearing a different
 * coat. `CONCAT_WS` is not: it skips NULL arguments, which is what people reach for once bitten.
 */
function enclosing(tokens: readonly Token[], idx: number, limit: number): "absorbed" | "concat" | undefined {
  let depth = 0;
  for (let i = idx - 1; i >= limit; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = tokens[i - 1];
      if (name?.t !== "id" || name.q) continue;
      const upper = name.v.toUpperCase();
      // The innermost opinion is the one that counts: in `CONCAT(COALESCE(v, ''), x)` the variable
      // never reaches the CONCAT as a NULL.
      if (ABSORBING.has(upper)) return "absorbed";
      if (upper === "CONCAT") return "concat";
    } else if (t.v === ";" && depth === 0) return undefined;
  }
  return undefined;
}

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

/**
 * Variables the same statement also asks about directly, folded.
 *
 * `IF v IS NOT NULL AND v != x THEN` and `… WHERE t.c != v OR v IS NULL` are both somebody who
 * thought about it, and the second half of each is the finding this rule would otherwise make. One
 * `IS NULL` anywhere in the statement is taken as having handled it: the alternative is deciding
 * whether a particular `OR` covers a particular `AND`, which is a parse this backend does not do,
 * and being wrong about that would mean arguing with the author's own guard.
 */
function nullTested(ctx: BaseContext & { statements(): readonly TokenRange[] }): Map<number, Set<string>> {
  const { tokens, dialect } = ctx;
  const byStatement = new Map<number, Set<string>>();

  for (const statement of ctx.statements()) {
    const names = new Set<string>();
    for (let i = statement.from; i <= statement.to; i++) {
      const t = tokens[i]!;
      if (t.t !== "id" || t.q || !kw(tokens[i + 1], "IS")) continue;
      if (kw(tokens[i + 2], "NULL") || (kw(tokens[i + 2], "NOT") && kw(tokens[i + 3], "NULL"))) {
        names.add(dialect.foldIdentifier(t.v, false));
      }
    }
    if (names.size > 0) byStatement.set(statement.from, names);
  }
  return byStatement;
}

export const nullableVariableInPredicate: Rule = {
  id: "routine/nullable-variable-in-predicate",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A nullable column reaching a **negated** comparison, or a \`CONCAT\`, through a variable.

The third place a taint from \`SELECT col INTO v\` escapes, after arithmetic, and the two ways it does
it fail quietly in opposite directions:

  - **A NULL is not "different from" anything, and MySQL still says no.** This is the whole reason
    the rule looks at \`!=\` and not at \`=\`: \`v = 'A'\` coming out false for a NULL agrees with every
    reader — it is not 'A'. \`v != 'A'\` is where the code and the engine part company, because a NULL
    is not 'A' by any reading a person gives that line, and the comparison is still unknown, and
    unknown reads as false. \`IF v != 'A' THEN raise\` does not raise; \`WHERE t.c != v\` returns
    nothing.
  - **\`CONCAT\` spreads a NULL rather than skipping it.** One NULL argument and the *whole string* is
    NULL — not that argument missing from it, the entire result gone — which is how an error message,
    a key, or a whole \`PREPARE\`d statement turns into nothing at all. \`CONCAT_WS\` skips NULLs, and
    is not reported.

The taint is the one \`routine/nullable-into-arithmetic\` uses, computed once and shared: a variable is
suspect only where a \`SELECT … INTO\` filled it, by position, from a column the **catalog** says is
nullable. That is what separates this from guessing about variables — nothing in the file itself
knows that \`SELECT closed_at INTO v_closed\` may have left a variable holding nothing.

What it deliberately leaves alone:

  - **A statement that asks about the NULL itself.** \`IF v IS NOT NULL AND v != x THEN\` and
    \`… WHERE t.c != v OR v IS NULL\` are both somebody who thought about this, and one \`IS NULL\`
    anywhere in the statement is taken as having handled it. Deciding whether a particular \`OR\`
    covers a particular \`AND\` is a parse this backend does not do, and being wrong about it would
    mean arguing with the author's own guard.
  - **\`<=>\`**, the NULL-safe equality, which is the operator that exists for exactly this.
  - **A read already wrapped** in \`COALESCE\` or \`IFNULL\` — including inside a \`CONCAT\`, where
    \`CONCAT(COALESCE(v, ''), x)\` is the fix and the innermost wrapper is the one that counts.
  - **\`=\`, \`<\`, \`>\` and the rest**, where unknown-reads-as-false is the same answer the person
    reading the line would give.

**What it does not model**, and this it shares with the arithmetic rule: a later assignment from a
source that cannot be NULL does not clear the taint. That needs flow analysis this backend does not
do, and the exchange is worth naming — it can be wrong about a variable that was tainted and then
fixed, and in return it is never wrong about what tainted it.`,

  check(ctx) {
    const tainted = nullableSources(ctx);
    if (tainted.size === 0) return;

    const { written } = assignmentTargets(ctx);
    const { tokens } = ctx;
    const asked = nullTested(ctx);
    const statements = ctx.statements();

    let statement = 0;
    tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      while (statement < statements.length && statements[statement]!.to < i) statement++;

      if (t.t !== "id" || t.q || written.has(i) || punct(tokens[i - 1], ".")) return;
      const origin = tainted.get(ctx.dialect.foldIdentifier(t.v, false));
      if (!origin) return;

      // `v <=> x` and `v IS [NOT] NULL` are the two ways of asking about the NULL on purpose.
      if ([tokens[i - 1], tokens[i + 1]].some((n) => n?.t === "punct" && n.v === "<=>")) return;
      if (kw(tokens[i + 1], "IS")) return;

      const here = statements[statement];
      if (here && here.from <= i && asked.get(here.from)?.has(ctx.dialect.foldIdentifier(t.v, false))) return;

      const wrapper = enclosing(tokens, i, here?.from ?? 0);
      if (wrapper === "absorbed") return;

      const how = negated(tokens, i);
      if (how) {
        ctx.report(
          t,
          `${t.v} comes from ${origin}, which is nullable, and a NULL is not "${how}" anything: ` +
            "MySQL answers unknown, which reads as false",
        );
      } else if (wrapper === "concat") {
        ctx.report(t, `${t.v} comes from ${origin}, which is nullable; one NULL argument makes the whole CONCAT NULL`);
      }
    });
  },
};
