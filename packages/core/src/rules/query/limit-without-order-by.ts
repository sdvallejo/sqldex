import { isKeyLookup, readsKnownTables, singleTableQuery } from "../shared/keys.ts";
import { unorderedLimits } from "../shared/limits.ts";
import { selectList } from "../shared/selects.ts";
import { punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Rule, StatementContext } from "../rule.ts";

/**
 * Does the query read back only columns its own `WHERE` fixed to a value?
 *
 * `SELECT order_id FROM refunds WHERE order_id = p_order AND status = 'B' LIMIT 1` returns `p_order`
 * whichever row it lands on: it is a question about whether a row is there, written without `EXISTS`. One table
 * only, because that is where an unqualified name can belong to nothing else.
 */
function readsOnlyPinned(ctx: StatementContext, select: number, close: number): boolean {
  const query = singleTableQuery(ctx, select, close);
  if (!query || query.pinned.length === 0) return false;
  const list = selectList(ctx.tokens, select, close);
  if (!list) return false;

  const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
  const pinned = new Set(query.pinned.map(fold));
  return splitCommas(ctx.tokens, list.from, list.to).every(({ from, to }) => {
    const qualified = to === from + 2 && ctx.tokens[from]?.t === "id" && punct(ctx.tokens[from + 1], ".");
    if (to !== from && !qualified) return false;
    const column = ctx.tokens[to]!;
    return column.t === "id" && pinned.has(fold(column.v));
  });
}

export const limitWithoutOrderBy: Rule = {
  id: "query/limit-without-order-by",
  group: "query",
  severity: "hint",
  scope: "statement",
  docs: `A \`LIMIT\` that keeps some rows of a query nothing puts in order.

Without an \`ORDER BY\`, which rows a \`LIMIT\` keeps follows the access path the optimizer picks.
Adding an index to the table changes the row \`SELECT order_id FROM orders WHERE status = 'A' LIMIT
1\` returns, and the two that \`SELECT order_id FROM orders LIMIT 2\` returns, with no change to the
data or to the query, and no error or warning anywhere. The query keeps working, and keeps returning rows,
which is why nobody notices that they are different ones.

**This is a hint and not a warning because a \`LIMIT\` is very often the author meaning *any of them
will do*.** A query that takes whichever row it finds, a search capped at a hundred matches, a batch
of the next five thousand pending tasks: each is correct whichever rows come back, and nothing here
can tell that apart from the author who meant particular rows and forgot to say which.

What the rule can add depends on the count:

  - **A count other than one** — a larger literal, or a variable or a \`?\` — is the query saying by
    itself that several rows match, and is reported without asking the catalog anything.
  - **\`LIMIT 1\`** may just as well be a belt on a query that only ever matches once, and only the
    schema's keys can say. It is reported only where the catalog knows every table the query reads
    and none of their keys guarantees a single match.

**The advice has a limit.** An \`ORDER BY\` over a column that is not unique still leaves the ties
undecided, so which of the tied rows comes first is as open as it was. This rule does not promise
that adding an \`ORDER BY\` is enough.

A \`LIMIT\` with an offset is \`query/limit-offset-without-order-by\`'s: there the query is one of
several calls that have to agree, which is a stronger claim than this one.

What it deliberately leaves alone:

  - **A lookup by key.** Where a whole primary key or unique index is fixed, or a join reaches its
    row through a foreign key onto the other table's key, there is only one row to choose.
  - **A query that reads back only what its \`WHERE\` fixed.** \`SELECT order_id FROM refunds WHERE
    order_id = p_order AND status = 'B' LIMIT 1\` returns the same value whichever row it finds: it
    asks whether a row is there, without spelling it \`EXISTS\`.
  - **A \`LIMIT 1\` over a table the catalog does not have**, including a temporary one, a derived
    table, and a \`UNION\`: the claim rests on knowing the keys, and where they are unknown there is
    none to make.
  - **\`LIMIT 0\`**, which is a probe for the shape of the result and keeps no rows.
  - **An aggregate with no \`GROUP BY\`**, which is one row whatever the plan.
  - **A subquery directly after \`EXISTS\`**, which asks only whether there is any row.
  - **A select list of nothing but literals**, where every row is the same row.
  - **\`UPDATE … LIMIT\` and \`DELETE … LIMIT\`**, which are a different statement with a different
    question. A \`SELECT\` nested inside one is judged like any other.
  - **A subquery whose parent has the \`ORDER BY\`**, and the reverse: each query is judged by its
    own clauses.`,

  check(ctx) {
    for (const { limit, select, close, union } of unorderedLimits(ctx)) {
      if (limit.offset) continue;

      // The catalog's scope for a `UNION` is one branch's, not the whole of it, so its keys are
      // neither a reason for silence nor, for a `LIMIT 1`, a reason to speak.
      if (!union) {
        if (isKeyLookup(ctx, select, close)) continue;
        if (readsOnlyPinned(ctx, select, close)) continue;
      }
      // `isKeyLookup` is `false` both for a search that was looked at and for one that could not be,
      // so for the one count that keys decide, what the schema knows has to be asked first.
      if (limit.count === 1 && (union || !readsKnownTables(ctx, select, close))) continue;

      ctx.report(
        ctx.tokens[limit.index]!,
        limit.count === 1
          ? "this LIMIT 1 has no ORDER BY and the keys of the tables it reads do not guarantee a single " +
              "matching row, so which row it returns depends on the access path the optimizer picks"
          : "this LIMIT has no ORDER BY, so which rows it keeps depends on the access path the optimizer " +
              "picks, and an index added later can change them",
      );
    }
  },
};
