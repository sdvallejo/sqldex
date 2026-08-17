import { relations } from "../../syntax/fast/stmt.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Rule, StatementContext } from "../rule.ts";
import { ARITHMETIC, insideNullSafe } from "../support.ts";

/**
 * Aliases the engine leaves NULL when the outer join finds no row.
 *
 * `LEFT JOIN` only. In a `RIGHT JOIN` everything on the *left* becomes nullable, which is far harder
 * to bound — and a schema that uses one is rare enough that guessing there would cost more than it
 * finds.
 */
function outerJoined(ctx: StatementContext): Map<string, string> {
  const nullable = new Map<string, string>();
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (!kw(ctx.tokens[i], "LEFT")) continue;
    let j = i + 1;
    if (kw(ctx.tokens[j], "OUTER")) j++;
    if (!kw(ctx.tokens[j], "JOIN")) continue;

    const joined = relations(ctx.dialect, ctx.tokens, j, Math.min(j + 16, ctx.statement.to))[0];
    if (!joined) continue;
    const label = joined.alias ?? joined.name;
    if (label) nullable.set(ctx.dialect.foldIdentifier(label, false), joined.name ?? label);
  }
  return nullable;
}

export const leftJoinArithmetic: Rule = {
  id: "query/left-join-arithmetic",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A \`LEFT JOIN\`'s column used in arithmetic with nothing to absorb a NULL.

If the right-hand row is missing the column is NULL, and **the whole** expression is then NULL — with
no error and no warning anywhere. It is the classic forgotten \`COALESCE\`, and the reason it survives is
that the query keeps working: it just returns nothing where it should return a number.

Only \`LEFT JOIN\`, and only a qualified reference, so which relation the column belongs to is known
rather than inferred. A reference already inside \`COALESCE\`, \`IFNULL\`, \`IF\` or an aggregate is the fix,
and is not reported — at any nesting depth, since a wrapper two parentheses out stops the NULL just as
well as one immediately around it.`,

  check(ctx) {
    const nullable = outerJoined(ctx);
    if (nullable.size === 0) return;

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!punct(ctx.tokens[i], ".")) continue;
      const alias = ctx.tokens[i - 1];
      const name = ctx.tokens[i + 1];
      if (alias?.t !== "id" || name?.t !== "id") continue;
      if (!nullable.has(ctx.dialect.foldIdentifier(alias.v, alias.q ?? false))) continue;

      const before = ctx.tokens[i - 2];
      const after = ctx.tokens[i + 2];
      const inArithmetic =
        (before?.t === "punct" && ARITHMETIC.has(before.v)) ||
        (after?.t === "punct" && ARITHMETIC.has(after.v));
      if (!inArithmetic || insideNullSafe(ctx.tokens, i)) continue;

      ctx.report(
        name,
        `${alias.v}.${name.v} can be NULL because of the LEFT JOIN; without COALESCE the whole expression is NULL`,
      );
    }
  },
};
