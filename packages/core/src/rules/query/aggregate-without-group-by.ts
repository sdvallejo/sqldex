import { bareColumnCandidate } from "../shared/names.ts";
import { AGGREGATES } from "../shared/rows.ts";
import { kw, kwAny, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** Clauses that end the select list, whichever comes first. */
const AFTER_LIST: ReadonlySet<string> = new Set(["FROM", "INTO"]);

/** The index of a keyword at the statement's own depth, or `-1`. */
function clauseAt(ctx: StatementContext, word: string, second?: string): number {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], word) && (second === undefined || kw(tokens[i + 1], second))) return i;
  }
  return -1;
}

/** A column reference, or an aggregate call, at this level of the select list. */
function scan(
  ctx: StatementContext,
  from: number,
  to: number,
): { aggregates: number; columns: { token: (typeof ctx.tokens)[number]; text: string }[] } {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const columns: { token: (typeof ctx.tokens)[number]; text: string }[] = [];
  let aggregates = 0;

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    // A subquery's names are its own, and an aggregate inside it aggregates its rows, not these.
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (t.t === "id" && !t.q && punct(tokens[i + 1], "(")) {
      if (AGGREGATES.has(t.v.toUpperCase())) {
        aggregates++;
        const close = matchingParen(tokens, i + 1);
        i = close === -1 ? to : close;
      }
      continue;
    }
    if (t.t !== "id") continue;
    if (ctx.locals.byName.has(fold(t.v)) && !punct(tokens[i + 1], ".")) continue;

    if (punct(tokens[i + 1], ".") && tokens[i + 2]?.t === "id") {
      columns.push({ token: tokens[i + 2]!, text: `${fold(t.v)}.${fold(tokens[i + 2]!.v)}` });
      i += 2;
    } else if (bareColumnCandidate(tokens, i)) {
      columns.push({ token: t, text: fold(t.v) });
    }
  }
  return { aggregates, columns };
}

export const aggregateWithoutGroupBy: Rule = {
  id: "query/aggregate-without-group-by",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A column beside an aggregate, in a query that groups by nothing.

\`SELECT customer, SUM(total) FROM orders\` returns **one** row — that is what aggregating without a
\`GROUP BY\` means — and the \`customer\` on it belongs to whichever row the server happened to read.
Not the first, not the largest, no promise at all. A server with \`ONLY_FULL_GROUP_BY\`, which is the
default since 5.7, refuses the statement outright with error 1055; one without it answers, and the
answer looks like an answer.

**This is the half of the question that needs nothing but the query.** Its sibling
\`query/only-full-group-by\` reads the schema's keys to decide whether a grouping determines a column,
which is a real piece of reasoning with real ways to be wrong. Here there is no grouping to reason
about: one row comes back, and every column named beside the aggregate is arbitrary. Separating them
means the cheap answer can be trusted without auditing the expensive one.

What it leaves alone:

  - **A select list that names no column at all** — \`SELECT COUNT(*) FROM orders\` is the whole point
    of aggregating and says nothing about any row.
  - **The name a select item is given**: \`SUM(total) AS total\` names a result, not a column.
  - **A parameter or a local**, which is constant for the query.
  - **\`SELECT *\`**, where there is nothing to name and the answer would be a guess.
  - **A query with a \`GROUP BY\`**, which is the other rule's to judge.`,

  check(ctx) {
    const { tokens } = ctx;
    if (!kw(tokens[ctx.statement.from], "SELECT")) return;
    if (clauseAt(ctx, "GROUP", "BY") !== -1) return;

    const from = clauseAt(ctx, "FROM");
    const into = clauseAt(ctx, "INTO");
    const end = from === -1 ? into : into === -1 ? from : Math.min(from, into);
    if (end === -1 || kwAny(tokens[end], AFTER_LIST) === undefined) return;

    // A `*` of the list itself says nothing about which columns those are. `COUNT(*)`'s star is not
    // one, and reading it as a wildcard would silence this everywhere it matters.
    let depth = 0;
    for (let i = ctx.statement.from + 1; i < end; i++) {
      if (punct(tokens[i], "(")) depth++;
      else if (punct(tokens[i], ")")) depth--;
      else if (depth === 0 && punct(tokens[i], "*")) return;
    }

    for (const item of splitCommas(tokens, ctx.statement.from + 1, end - 1)) {
      // The name an item is given is not a column: `expr AS x` and the bare `expr x` alike.
      let last = item.to;
      if (tokens[last]?.t === "id" && last > item.from && !punct(tokens[last - 1], ".")) {
        last = kw(tokens[last - 1], "AS") ? last - 2 : last - 1;
      }
      const { aggregates, columns } = scan(ctx, item.from, last);
      if (aggregates > 0 || columns.length === 0) continue;

      // Only if the statement aggregates at all, which is what makes it one row.
      if (scan(ctx, ctx.statement.from + 1, end - 1).aggregates === 0) return;

      const first = columns[0]!;
      ctx.report(
        first.token,
        `${first.text} is beside an aggregate and grouped by nothing: one row comes back, and this ` +
          "column is whichever row the server read — a server with ONLY_FULL_GROUP_BY refuses it outright",
      );
      return;
    }
  },
};
