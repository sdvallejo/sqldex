import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Table } from "../../model/table.ts";
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

/** Aggregates fold a whole group into one row, which is the other way of having only one. */
const AGGREGATES: ReadonlySet<string> = new Set([
  "AVG",
  "BIT_AND",
  "BIT_OR",
  "BIT_XOR",
  "COUNT",
  "GROUP_CONCAT",
  "JSON_ARRAYAGG",
  "JSON_OBJECTAGG",
  "MAX",
  "MIN",
  "STD",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "SUM",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
]);

/**
 * Does the query fold its rows into one, by aggregating without grouping?
 *
 * The `GROUP BY` is the half that is easy to forget: `SELECT SUM(x) FROM t GROUP BY y` is an
 * aggregate and still returns one row *per group*, so it is exactly as capable of returning several
 * as the query with no aggregate at all.
 *
 * Aggregates inside a nested subquery are skipped whole, since folding that query's rows says
 * nothing about how many this one returns.
 */
function foldsToOneRow(tokens: readonly Token[], from: number, to: number): boolean {
  let aggregate = false;
  let depth = 0;

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "GROUP") && kw(tokens[i + 1], "BY")) return false;
    else if (t.t === "id" && !t.q && punct(tokens[i + 1], "(") && AGGREGATES.has(t.v.toUpperCase())) {
      aggregate = true;
    }
  }
  return aggregate;
}

/** `LIMIT 1`, in either of its two spellings, at the query's own depth. */
function limitsToOne(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "LIMIT")) {
      // `LIMIT 1` and `LIMIT 0, 1` both take one row; the count is the last number either way.
      const count = punct(tokens[i + 2], ",") ? tokens[i + 3] : tokens[i + 1];
      return count?.t === "num" && Number(count.v) === 1;
    }
  }
  return false;
}

/** Is this `(SELECT …)` a derived table of the query around it, rather than a value in it? */
function isDerivedTable(ctx: StatementContext, open: number): boolean {
  let scope: ScopeInfo | undefined = ctx.scopeAt(open);
  while (scope) {
    if (scope.relations.some((relation) => relation.derived?.from === open)) return true;
    scope = scope.parent;
  }
  return false;
}

/** A unique key the `WHERE` starts and does not finish, with the columns it left free. */
interface HalfKey {
  key: readonly string[];
  /** The key's own columns the `WHERE` fixes, which is not every column it fixes. */
  held: string[];
  free: string[];
}

/**
 * The unique key this search starts and abandons, if there is one.
 *
 * **This is the whole rule.** A `WHERE` that mentions nothing any key mentions is a search the
 * schema has no opinion about — the column may well be unique in practice, and saying otherwise
 * would be guessing out loud once per query in the repo. A `WHERE` that fixes *part* of a declared
 * key is different: the schema itself says the rest of that key is free to vary, so a second row is
 * not a hypothesis, it is what the key is for.
 *
 * Every key is read before answering, because covering one of them whole is enough — and a table
 * whose primary key is `(account_id, holder_id)` will usually also carry `UNIQUE (account_id)`.
 */
function halfPinnedKey(
  fold: (name: string) => string,
  table: Table,
  pinned: readonly string[],
): HalfKey | undefined {
  const fixed = new Set(pinned.map(fold));
  const keys = [table.primaryKey, ...table.indexes.filter((index) => index.unique).map((index) => index.columns)];

  let half: HalfKey | undefined;
  for (const key of keys) {
    if (key.length === 0) continue;
    const free = key.filter((name) => !fixed.has(fold(name)));
    // Any key covered whole is one row, whatever the other keys have left over: a query that fixes
    // `UNIQUE (account_id)` is pinned down even though the primary key `(account_id, holder_id)` has
    // a column to spare.
    if (free.length === 0) return undefined;
    if (free.length < key.length) half ??= { key, held: key.filter((name) => fixed.has(fold(name))), free };
  }
  return half;
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
