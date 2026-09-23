import { isKeyLookup } from "../shared/keys.ts";
import { ARITHMETIC } from "../shared/nulls.ts";
import { aggregatesIn, readSubquery } from "../shared/subqueries.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const nullableScalarSubquery: Rule = {
  id: "query/nullable-scalar-subquery",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A subquery used as a number, in a query that never says what it should be when it finds nothing.

\`SET total = paid + (SELECT amount FROM refunds WHERE …)\` is NULL — the whole of it, not the
subquery's half — on any day the subquery matches no row. Nothing errors and nothing is out of place:
a scalar subquery over an empty result **is** NULL, and NULL plus anything is NULL, so the statement
writes a NULL over what was about to be a number.

**An outer \`COALESCE\` is what makes this dangerous rather than obvious.** In
\`COALESCE(paid + (SELECT …), 0)\` the wrapper is not protecting the sum; it is catching the NULL the
subquery caused and writing a confident \`0\` in its place. The total is then not zero, it is unknown,
and this is the shape that runs for years without anybody noticing. Every other NULL rule here goes
quiet inside a \`COALESCE\`; this one is why that is not a general truth.

The fix is **inside** the subquery, which is the only place with something left to say: an aggregate
wrapped in its own \`COALESCE(SUM(…), 0)\`, or a \`COUNT\`, which answers \`0\` over no rows by itself.

Nullability of the column decides nothing here, and looking at it would be looking at the wrong
thing: the NULL does not come from the data, it comes from there being no row to take data from. A
\`NOT NULL\` column in a subquery that matches nothing is NULL exactly like any other.

What it deliberately leaves alone:

  - **A lookup of one row by its key.** \`SELECT value FROM settings WHERE parameter = 'X'\`, where the
    \`WHERE\` fixes a whole primary key or unique index of the one table read, is somebody reading a
    row they know is there — and saying it might not be is a claim about their data, not about their
    query. A search is the opposite: a range of dates, a status that is not one value, a join that
    can eliminate the row. Finding nothing is one of a search's ordinary outcomes, and that is
    exactly when this happens. **The catalog is what tells the two apart**, and nothing else can:
    the same \`WHERE\` is a lookup against one table and a search against another. A join to another
    table through a \`NOT NULL\` foreign key onto that table's whole primary key keeps it a lookup —
    the schema itself guarantees the joined row is there — while a join the catalog cannot vouch for,
    an undeclared foreign key, a nullable one, a join to a column that is not the other table's key,
    is still a search.
  - **\`COUNT\`**, the one aggregate an empty set does not turn into a NULL.
  - **An aggregate already wrapped** in \`COALESCE\` or \`IFNULL\` inside the subquery, which is the fix.
    Each aggregate is judged on its own: \`COALESCE(SUM(a), 0) - COALESCE(SUM(b), 0)\` is covered, and
    an item where only one of the two is wrapped is not.
  - **A \`SELECT\` with no \`FROM\`**: it computes its one row out of nothing, so there is no empty
    result for it to fall into.
  - **A subquery that is not an operand of arithmetic.** \`IN (SELECT …)\` and \`EXISTS (SELECT …)\` have
    an answer for the empty case, and an assignment straight from a subquery — \`SET v = (SELECT …)\` —
    leaves the NULL visible in \`v\` instead of folding it into a number. That NULL is not left
    unwatched: \`routine/nullable-into-arithmetic\` and its two siblings follow it out of \`v\`, the same
    way they follow one out of a nullable column, to wherever the variable next reaches arithmetic, a
    negated comparison, or a \`CONCAT\`.`,

  check(ctx) {
    const { tokens, dialect } = ctx;
    const fold = (name: string): string => dialect.foldIdentifier(name, false);

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!punct(tokens[i], "(") || !kw(tokens[i + 1], "SELECT")) continue;
      const close = matchingParen(tokens, i);
      if (close === -1 || close > ctx.statement.to) continue;

      // Only as an operand: what makes this a defect is the NULL escaping into a number, and an
      // operator on one side or the other is what carries it out.
      const before = tokens[i - 1];
      const after = tokens[close + 1];
      const operand =
        (before?.t === "punct" && ARITHMETIC.has(before.v)) || (after?.t === "punct" && ARITHMETIC.has(after.v));
      if (!operand) continue;

      const sub = readSubquery(tokens, i, close);
      if (!sub) continue;

      // An aggregate answers an empty set instead of vanishing, so the subquery has its one row
      // whatever happens — unless a `GROUP BY` means there may be no group to answer for.
      const aggregate = aggregatesIn(tokens, sub.item);
      if (aggregate.any && !sub.grouped) {
        const at = aggregate.unprotected[0];
        if (at === undefined) continue;
        ctx.report(
          tokens[at]!,
          `${tokens[at]!.v.toUpperCase()} is NULL when it aggregates no rows, and that NULL becomes the whole ` +
            "expression: wrap it in COALESCE inside the subquery",
        );
        continue;
      }

      if (isKeyLookup(ctx, i + 1, close)) continue;

      ctx.report(
        tokens[i + 1]!,
        "this subquery is NULL when it matches no row, and that NULL becomes the whole expression",
      );
    }
  },
};
