import { fromComment, isEnumLike } from "../../analysis/values.ts";
import { columnAt, setClause } from "../shared/columns.ts";
import type { Column } from "../../model/table.ts";
import { kw, matchingParen, punct, unquote } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Comparisons that ask whether the column holds this exact code. */
const EQUALITIES: ReadonlySet<string> = new Set(["=", "!=", "<>", "<=>"]);

/**
 * The codes the column's own `COMMENT` declares, or `undefined` when it declares none.
 *
 * `fromComment` already refuses a comment with one option in it — "a sentence with a colon in it" —
 * so a set that comes back here is one somebody wrote on purpose.
 */
function declared(column: Column): { codes: string[]; folded: Set<string> } | undefined {
  if (!isEnumLike(column)) return undefined;
  const values = fromComment(column.comment);
  if (!values || values.length === 0) return undefined;
  return {
    codes: values.map((value) => value.code),
    folded: new Set(values.map((value) => value.code.toLowerCase())),
  };
}

/**
 * Is this literal a code the column cannot hold?
 *
 * **Compared case-insensitively**, because that is what the server does: under the `_ci` collations
 * these columns almost always carry, `Estado = 'p'` finds every row holding `'P'`, and reporting it
 * as impossible would be reporting a comparison that works.
 *
 * The empty string is never reported. `char(1) NOT NULL DEFAULT ''` is ordinary, so `= ''` is a real
 * question about real rows — and no `COMMENT` documents the absence of a code as one of the codes.
 */
function undeclared(set: { folded: Set<string> }, literal: Token): string | undefined {
  const text = unquote(literal.v);
  if (text.length === 0) return undefined;
  return set.folded.has(text.toLowerCase()) ? undefined : text;
}

export const enumValueNotDefined: Rule = {
  id: "query/enum-value-not-defined",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A comparison against a code an enum-like column does not declare.

Schemas that predate \`ENUM\`, or distrust it, use \`char(1)\` as one: a column holding \`'P'\`, \`'A'\`,
\`'R'\` and nothing else, with the set written down in its \`COMMENT\`. A \`WHERE Estado = 'X'\` against
such a column is not an error and not a warning from anywhere — it is a condition that is false for
every row that exists, so the query returns nothing, forever, for a reason nothing on the line
explains. A typo in a status code reads exactly like "there is no data yet".

**The \`COMMENT\` is the only source this rule will use, and that restriction is the rule.** sqldex
also derives these sets from the literals the procedures compare against, which covers far more
columns — and that source is a **lower bound**: a value no procedure mentions is still legal, so it
can say "these have been used" and never "these are the only ones". Building a finding on it would
report every code that happens to be rare. The \`COMMENT\` is the author stating the set, and it is
the only thing here that can support the claim.

Case is ignored, because the server ignores it: under the \`_ci\` collations these columns carry,
\`= 'p'\` finds the rows holding \`'P'\`.

What it deliberately leaves alone:

  - **A column whose \`COMMENT\` says nothing**, which is most of them. Silence is not evidence that a
    code is legal; it is the absence of anybody having written the set down.
  - **A comment with one option in it.** That is a sentence with a colon in it, and the reader that
    parses these already refuses it as a set.
  - **The empty string.** \`char(1) NOT NULL DEFAULT ''\` is ordinary, and no comment lists the absence
    of a code among the codes.
  - **A numeric literal**, which is \`query/literal-type-mismatch\`'s finding: the problem there is not
    which code it is, it is that comparing a text column with a number converts the column.
  - **An \`UPDATE\`'s \`SET\`.** Writing an undeclared code is a real defect and a different claim — it
    stores something rather than matching nothing — and one id covering both would put two problems
    behind one severity and one suppression comment.
  - **A bare column two relations could own**, and \`>\`/\`<\`, which order codes rather than test them.`,

  check(ctx) {
    const { tokens } = ctx;
    const assignments = setClause(ctx);

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const operator = tokens[i]!;
      if (i > assignments.from && i < assignments.to) continue;

      // `IN` is the same test written with a word, once per value — but only over a list. The
      // literals inside `IN (SELECT …)` belong to that query's own conditions, not to this column.
      if (kw(operator, "IN") && punct(tokens[i + 1], "(") && !kw(tokens[i + 2], "SELECT")) {
        const found = columnAt(ctx, i - 1);
        const set = found ? declared(found.column) : undefined;
        const close = matchingParen(tokens, i + 1);
        if (!found || !set || close === -1) continue;

        const unknown: string[] = [];
        let depth = 0;
        for (let j = i + 2; j < close; j++) {
          const literal = tokens[j]!;
          if (punct(literal, "(")) depth++;
          else if (punct(literal, ")")) depth--;
          if (depth !== 0 || literal.t !== "str") continue;
          const bad = undeclared(set, literal);
          if (bad !== undefined) unknown.push(bad);
        }
        if (unknown.length > 0) {
          ctx.report(
            tokens[i - 1]!,
            `${found.text} declares (${set.codes.join(", ")}) and this looks for ` +
              `${unknown.map((code) => `'${code}'`).join(", ")}: no row can hold that`,
          );
        }
        continue;
      }

      if (operator.t !== "punct" || !EQUALITIES.has(operator.v)) continue;

      for (const [name, value] of [
        [i - 1, i + 1],
        [i + 1, i - 1],
      ] as const) {
        const literal = tokens[value];
        if (literal?.t !== "str") continue;
        // `a.b = 'x'` puts the dot next to the operator, so the qualified form is read from its name.
        if (punct(tokens[value - 1], ".") || punct(tokens[value + 1], ".")) continue;

        const found = columnAt(ctx, name);
        const set = found ? declared(found.column) : undefined;
        if (!found || !set) continue;

        const bad = undeclared(set, literal);
        if (bad === undefined) continue;

        // `!=` against an undeclared code is true for every row rather than none, which is the same
        // mistake read from the other end and just as certainly not what was written.
        const effect = operator.v === "=" || operator.v === "<=>" ? "no row can hold that" : "every row passes this";
        ctx.report(
          tokens[name]!,
          `${found.text} declares (${set.codes.join(", ")}) and this compares it with '${bad}': ${effect}`,
        );
        break;
      }
    }
  },
};
