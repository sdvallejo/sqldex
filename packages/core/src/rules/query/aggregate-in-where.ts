import { AGGREGATES } from "../shared/rows.ts";
import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/** Words that end a `WHERE` at its own depth. */
const AFTER_WHERE: ReadonlySet<string> = new Set([
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "INTO",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "PROCEDURE",
  "FOR",
  "LOCK",
  "WINDOW",
]);

export const aggregateInWhere: Rule = {
  id: "query/aggregate-in-where",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `An aggregate called in a \`WHERE\`.

MySQL refuses it: error 1111, *invalid use of group function*. A \`WHERE\` decides which rows go into
a group, so it runs before there is a group to aggregate — the condition the author wanted belongs in
\`HAVING\`, which runs after.

The two clauses read alike and that is the whole of the mistake: \`WHERE SUM(amount) > 1000\` is what
anybody writes the first time, and the statement never runs at all. It is not a slow query or a wrong
number, it is a procedure that fails on the day the branch holding it is taken.

**An aggregate inside a subquery is not this defect and is skipped whole**, which is the guard that
makes the rule usable: \`WHERE order_id IN (SELECT MAX(order_id) FROM orders)\` and
\`WHERE total > (SELECT AVG(total) FROM orders)\` are how the comparison is spelled correctly, and
both are accepted. The subquery's aggregate folds *its* rows, not this query's.

**Only a \`WHERE\` at the statement's own depth is judged**, and the reason is a shape that reads like
this defect and is not: MySQL permits an aggregate in a *subquery's* \`WHERE\` when its argument
belongs to the **outer** query — \`(SELECT … FROM b WHERE
b.id = MAX(a.id))\` is evaluated as an aggregate of the query outside, and the server accepts it.
It refuses the same shape when the aggregate is over the subquery's own table, so the two are told
apart by which query owns the column — a question this rule stands down on rather than answers,
since the clause it exists for is the one at the top.

A window function — \`SUM(x) OVER (…)\` — is left alone too. It is also refused in a \`WHERE\`, but
with a different error and for a different reason, and reporting it here would state the wrong one.

Verified against a live server, since it is the sentence the message makes: the aggregate is refused
in the \`WHERE\` of a \`SELECT\`, of an \`UPDATE\` and of a \`DELETE\` alike, and accepted in \`HAVING\`.`,

  check(ctx) {
    const { tokens } = ctx;

    let outer = 0;
    for (let where = ctx.statement.from; where <= ctx.statement.to; where++) {
      if (punct(tokens[where], "(")) outer++;
      else if (punct(tokens[where], ")")) outer--;
      // A `WHERE` inside parentheses belongs to a subquery, and there an aggregate may be the outer
      // query's — which MySQL allows. Every branch of a `UNION` is still at this depth.
      if (outer !== 0 || !kw(tokens[where], "WHERE")) continue;

      let depth = 0;
      for (let i = where + 1; i <= ctx.statement.to; i++) {
        const t = tokens[i]!;
        if (punct(t, "(")) {
          // A subquery's rows are its own, and so is anything it aggregates.
          const close = matchingParen(tokens, i);
          if (kw(tokens[i + 1], "SELECT") && close !== -1) i = close;
          else depth++;
          continue;
        }
        if (punct(t, ")")) {
          // The parenthesis this `WHERE` lives inside: its clause ends here.
          if (depth === 0) break;
          depth--;
          continue;
        }
        if (depth === 0 && (punct(t, ";") || kwAny(t, AFTER_WHERE) !== undefined)) break;
        if (t.t !== "id" || t.q || !punct(tokens[i + 1], "(")) continue;
        if (!AGGREGATES.has(t.v.toUpperCase())) continue;

        const close = matchingParen(tokens, i + 1);
        // `SUM(x) OVER (…)` is a window function: refused here too, but not with this error.
        if (close !== -1 && kw(tokens[close + 1], "OVER")) {
          i = close;
          continue;
        }

        ctx.report(
          t,
          `${t.v.toUpperCase()} in a WHERE: an aggregate has nothing to fold before the rows are ` +
            "grouped, so MySQL refuses the statement — this condition belongs in HAVING",
        );
        return;
      }
    }
  },
};
