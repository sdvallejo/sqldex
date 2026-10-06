import { unorderedLimits } from "../shared/limits.ts";
import type { Rule } from "../rule.ts";

export const limitOffsetWithoutOrderBy: Rule = {
  id: "query/limit-offset-without-order-by",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A \`LIMIT\` that skips rows of a query nothing puts in order.

An offset is a query that is meant to be run more than once: \`LIMIT 20, 10\` is the third page of
something whose first two were read by an earlier call, and \`LIMIT p_index, 1\` inside a loop is the
next row of a walk. Both only mean anything if every run sees the rows in the same order, and without
an \`ORDER BY\` nothing says they will. Which rows a \`LIMIT\` keeps follows the access path the
optimizer picks: adding an index to the table changes the rows \`SELECT order_id FROM orders LIMIT 1,
2\` returns, with no change to the data or to the query, and no error or warning anywhere. Pages
overlap, or a row is never on any of them, and each call looks correct on its own.

What it reports is the offset itself, in either spelling — \`LIMIT m, n\` and \`LIMIT n OFFSET m\` —
whatever the count is. It needs nothing from the catalog: the query says by itself that it is one
of several calls that have to agree.

A \`LIMIT\` with no offset is a different question, with a different confidence, and is
\`query/limit-without-order-by\`'s.

**The advice has a limit.** An \`ORDER BY\` over a column that is not unique still leaves the ties
undecided, so a row tied across a page boundary can still appear on both pages or on neither. This
rule does not promise that adding an \`ORDER BY\` is enough; it says that without one nothing was
being decided at all.

What it deliberately leaves alone:

  - **An offset of a literal \`0\`**, which skips nothing: \`LIMIT 0, 1\` is \`LIMIT 1\`.
  - **\`LIMIT 0\`**, which is a probe for the shape of the result and keeps no rows.
  - **An aggregate with no \`GROUP BY\`**, which is one row whatever the plan.
  - **A subquery directly after \`EXISTS\`**, which asks only whether there is any row.
  - **A select list of nothing but literals**, where every row is the same row.
  - **A \`UNION\` with an \`ORDER BY\` anywhere at its depth**, which orders the whole of it.
  - **A subquery whose parent has the \`ORDER BY\`**, and the reverse: each query is judged by its
    own clauses, because the outer \`ORDER BY\` orders the outer rows and leaves the inner \`LIMIT\`
    exactly as it was.`,

  check(ctx) {
    for (const { limit } of unorderedLimits(ctx)) {
      if (!limit.offset) continue;

      ctx.report(
        ctx.tokens[limit.index]!,
        "this LIMIT skips rows of a query with no ORDER BY, so which rows it skips depends on the " +
          "access path the optimizer picks, and two calls need not agree",
      );
    }
  },
};
