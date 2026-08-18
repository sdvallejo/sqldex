import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";
import { ARITHMETIC, isKeyLookup } from "../support.ts";

/** Words between `SELECT` and the first item, which say nothing about what the item is. */
const SELECT_MODIFIERS: ReadonlySet<string> = new Set([
  "ALL",
  "DISTINCT",
  "DISTINCTROW",
  "HIGH_PRIORITY",
  "STRAIGHT_JOIN",
  "SQL_SMALL_RESULT",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
  "SQL_NO_CACHE",
  "SQL_CACHE",
  "SQL_CALC_FOUND_ROWS",
]);

/**
 * Aggregates that answer an empty set with NULL.
 *
 * `COUNT` is deliberately not here and that is the whole distinction the rule turns on: over no rows
 * it answers `0`, which is a number, and arithmetic on it is safe. Every other aggregate answers
 * NULL, and the answer looks exactly like the one for "the sum happens to be null".
 */
const AGGREGATES: ReadonlySet<string> = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
  "STD",
  "STDDEV",
  "STDDEV_POP",
  "STDDEV_SAMP",
  "VARIANCE",
  "VAR_POP",
  "VAR_SAMP",
]);

/** What turns the NULL back into a value — inside the subquery, where it can still help. */
const ABSORBING: ReadonlySet<string> = new Set(["COALESCE", "IFNULL"]);

/** Clauses that end the select list, and after which a `GROUP BY` may still show up. */
const AFTER_ITEM: ReadonlySet<string> = new Set(["FROM", "INTO"]);

interface Range {
  from: number;
  to: number;
}

/**
 * Is this token index inside a `COALESCE` or an `IFNULL`, without leaving `from`?
 *
 * Bounded at the item on purpose: this asks whether the NULL is absorbed *inside the subquery*,
 * which is where absorbing it fixes anything. A `COALESCE` around the whole expression outside is
 * exactly the shape this rule is about, and walking out to it would silence every finding.
 */
function absorbedWithin(tokens: readonly Token[], idx: number, from: number): boolean {
  let depth = 0;
  for (let i = idx - 1; i >= from; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = tokens[i - 1];
      if (name?.t === "id" && !name.q && ABSORBING.has(name.v.toUpperCase())) return true;
    }
  }
  return false;
}

/**
 * The aggregate calls of a select item, with any nested subquery of its own skipped whole.
 *
 * The skipping is what keeps `SELECT (SELECT SUM(x) FROM y) FROM z` honest: that `SUM` belongs to
 * the inner query and says nothing about whether *this* one returns a row.
 */
function aggregatesIn(tokens: readonly Token[], range: Range): { any: boolean; unprotected: number[] } {
  let any = false;
  const unprotected: number[] = [];

  for (let i = range.from; i <= range.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? range.to : close;
      continue;
    }
    if (t.t !== "id" || t.q || !punct(tokens[i + 1], "(")) continue;

    const name = t.v.toUpperCase();
    if (name === "COUNT") any = true;
    else if (AGGREGATES.has(name)) {
      any = true;
      if (!absorbedWithin(tokens, i, range.from)) unprotected.push(i);
    }
  }
  return { any, unprotected };
}

interface Subquery {
  /** The single select item, from the first token after `SELECT` up to the `FROM`. */
  item: Range;
  /** Whether a `GROUP BY` at its own depth can leave it with no row at all. */
  grouped: boolean;
}

/**
 * What the rule needs to know about a `( SELECT … )`, or `undefined` when it is not its business.
 *
 * Two shapes come back undefined and neither is a defect: a select list of several items is not a
 * scalar at all — MySQL rejects it in this position — and a `SELECT` with no `FROM` computes its one
 * row out of thin air, so "no rows matched" cannot happen to it.
 */
function readSubquery(tokens: readonly Token[], open: number, close: number): Subquery | undefined {
  let i = open + 2;
  while (kwAny(tokens[i], SELECT_MODIFIERS) !== undefined) i++;

  let depth = 0;
  let end = -1;
  for (let j = i; j < close; j++) {
    const t = tokens[j]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth !== 0) continue;
    // A comma at the item's own depth is a second item, so this was never a scalar.
    else if (punct(t, ",")) return undefined;
    else if (kwAny(t, AFTER_ITEM) !== undefined) {
      end = j;
      break;
    }
  }
  if (end === -1 || end === i) return undefined;

  let grouped = false;
  depth = 0;
  for (let j = end + 1; j < close; j++) {
    const t = tokens[j]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "GROUP") && kw(tokens[j + 1], "BY")) {
      grouped = true;
      break;
    }
  }

  return { item: { from: i, to: end - 1 }, grouped };
}

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
    the same \`WHERE\` is a lookup against one table and a search against another.
  - **\`COUNT\`**, the one aggregate an empty set does not turn into a NULL.
  - **An aggregate already wrapped** in \`COALESCE\` or \`IFNULL\` inside the subquery, which is the fix.
    Each aggregate is judged on its own: \`COALESCE(SUM(a), 0) - COALESCE(SUM(b), 0)\` is covered, and
    an item where only one of the two is wrapped is not.
  - **A \`SELECT\` with no \`FROM\`**: it computes its one row out of nothing, so there is no empty
    result for it to fall into.
  - **A subquery that is not an operand of arithmetic.** \`IN (SELECT …)\` and \`EXISTS (SELECT …)\` have
    an answer for the empty case, and an assignment straight from a subquery — \`SET v = (SELECT …)\` —
    leaves the NULL visible in \`v\` instead of folding it into a number.`,

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
