import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import { foldsToOneRow, halfPinnedKey, limitsToOne } from "../one-row.ts";
import type { Rule, ScopeInfo, StatementContext } from "../rule.ts";
import { joinNames, singleTableQuery } from "../support.ts";

/**
 * Words before a `(SELECT …)` that say it is not being read as one value.
 *
 * `IN`, `ANY`, `ALL` and `SOME` are the operators built for many rows, `EXISTS` asks only whether
 * there are any, and `FROM`, `JOIN`, `AS` and `UNION` introduce a query rather than a value. Each of
 * these makes several rows the ordinary case instead of an error.
 */
const NOT_A_VALUE: ReadonlySet<string> = new Set([
  "ALL",
  "ANY",
  "AS",
  "EXISTS",
  "FROM",
  "IN",
  "JOIN",
  "SOME",
  "UNION",
]);

/** Is this `(SELECT …)` a derived table of the query around it, rather than a value in it? */
function isDerivedTable(ctx: StatementContext, open: number): boolean {
  let scope: ScopeInfo | undefined = ctx.scopeAt(open);
  while (scope) {
    if (scope.relations.some((relation) => relation.derived?.from === open)) return true;
    scope = scope.parent;
  }
  return false;
}

export const scalarSubqueryManyRows: Rule = {
  id: "query/scalar-subquery-many-rows",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A subquery read as a single value, from a query with nothing stopping it from returning several.

MySQL's answer to \`SET rate = (SELECT rate FROM plans WHERE plan_id = p_plan AND status = 'A')\` when
two rows come back is not the first one and not an average: it is error 1242, *Subquery returns more
than 1 row*, and the statement stops there. The query is correct on every dataset where the search
happens to match once, which is usually the developer's, and it breaks the first time somebody adds
the second row.

What it reports is a search that **starts a unique key and abandons it**: the \`WHERE\` fixes some
columns of a declared key and leaves the rest free. That is not a hypothesis about the data — it is
the schema saying, in the only way it can, that those remaining columns are what tell two rows apart.
\`WHERE tax_id = ?\` against a table whose unique key is \`(id_kind, tax_id)\` is one number under two
kinds of identity document, and there is nothing else in the repo that knows that.

**Only the catalog can see it**, which is the whole reason this is checkable here and nowhere else:
the same \`WHERE\` finishes a key against one table and starts one against another.

Three shapes make one row certain, and any of them is enough for silence:

  - **The whole key.** Every column of a primary key or unique index fixed to a value.
  - **An aggregate**, which folds a group into one row — but not with a \`GROUP BY\`, which hands back
    one row *per group* and is as free to return several as no aggregate at all.
  - **\`LIMIT 1\`**, which is the author saying *any one of them will do*.

What it deliberately leaves alone:

  - **\`IN\`, \`ANY\`, \`ALL\`, \`SOME\` and \`EXISTS\`**, which are the operators for many rows: several is
    what they are for, not an error.
  - **A derived table**, \`FROM (SELECT …) x\`, which is a query and not a value.
  - **A search that touches no unique key at all.** \`WHERE type = 'Abandonment'\` against a lookup
    table with no unique index on \`type\` may be perfectly safe; the schema simply does not say, and
    a rule that reported it would be arguing about somebody's data rather than reading their schema.
  - **A join, and a table the catalog does not have**, including a temporary one. The claim rests on
    knowing the keys, and where they are unknown there is no claim to make — guessing would report
    every read of every temporary table in the repo.`,

  check(ctx) {
    const { tokens } = ctx;

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!punct(tokens[i], "(") || !kw(tokens[i + 1], "SELECT")) continue;
      const close = matchingParen(tokens, i);
      if (close === -1 || close > ctx.statement.to) continue;

      const before = tokens[i - 1];
      if (before?.t === "id" && !before.q && kwAny(before, NOT_A_VALUE) !== undefined) continue;
      if (isDerivedTable(ctx, i)) continue;

      if (foldsToOneRow(tokens, i + 2, close - 1)) continue;
      if (limitsToOne(tokens, i + 2, close - 1)) continue;

      const query = singleTableQuery(ctx, i + 1, close);
      if (!query) continue;
      const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
      const half = halfPinnedKey(fold, query.table, query.pinned);
      if (!half) continue;

      ctx.report(
        tokens[i + 1]!,
        `this subquery can return more than one row: ${query.table.name} is keyed on ` +
          `(${half.key.join(", ")}), and this fixes ${joinNames(half.held)} but leaves ` +
          `${joinNames(half.free)} free. MySQL answers error 1242 rather than a value`,
      );
    }
  },
};
