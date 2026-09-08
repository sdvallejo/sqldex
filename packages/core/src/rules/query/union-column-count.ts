import { selectList, selectWidth } from "../shared/selects.ts";
import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { TokenRange } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** The three operators that stack one query's rows on another's. */
const SET_OPERATORS: ReadonlySet<string> = new Set(["UNION", "EXCEPT", "INTERSECT"]);

/** A branch, unwrapped from the parentheses that are allowed to surround it. */
function unwrap(ctx: StatementContext, branch: TokenRange): TokenRange {
  let { from, to } = branch;
  while (punct(ctx.tokens[from], "(") && matchingParen(ctx.tokens, from) === to) {
    from++;
    to--;
  }
  return { from, to };
}

/** The branch's own `SELECT`, or `-1` — its own depth, so a subquery's does not stand in for it. */
function selectOf(ctx: StatementContext, branch: TokenRange): number {
  let depth = 0;
  for (let i = branch.from; i <= branch.to; i++) {
    if (punct(ctx.tokens[i], "(")) depth++;
    else if (punct(ctx.tokens[i], ")")) depth--;
    else if (depth === 0 && kw(ctx.tokens[i], "SELECT")) return i;
  }
  return -1;
}

/**
 * Reports the first branch of this region whose width differs from the first branch's.
 *
 * A region is one query's own depth: the statement, or what a pair of parentheses encloses. The
 * operators are matched at that depth alone, so the `UNION` of a derived table is compared with its
 * own siblings and not with the query around it — which is how the server reads it, and it refuses
 * the mismatch there just the same.
 */
function checkRegion(ctx: StatementContext, region: TokenRange): void {
  const { tokens } = ctx;
  const cuts: number[] = [];
  let depth = 0;
  for (let i = region.from; i <= region.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kwAny(tokens[i], SET_OPERATORS) !== undefined) cuts.push(i);
  }
  if (cuts.length === 0) return;

  const bounds = [region.from - 1, ...cuts, region.to + 1];
  let first: { width: number; at: number } | undefined;

  for (let branch = 0; branch < bounds.length - 1; branch++) {
    const range = unwrap(ctx, { from: bounds[branch]! + 1, to: bounds[branch + 1]! - 1 });
    const select = selectOf(ctx, range);
    // A branch this backend cannot read as a query — a `VALUES` row constructor, a `TABLE t` — is
    // not a branch with a wrong width; it is a branch with no width, and the rest go unjudged with
    // it, since every comparison here is against the first one.
    if (select === -1) return;
    const list = selectList(tokens, select, range.to);
    if (!list) return;
    const width = selectWidth(ctx, list, select, range.to);
    // A star over a relation the catalog does not hold has no count, and a count that is a guess
    // would report an error that is not there.
    if (width === undefined) return;

    if (first === undefined) {
      first = { width, at: select };
      continue;
    }
    if (width === first.width) continue;

    ctx.report(
      tokens[select]!,
      `this branch returns ${width} column(s) and the first returns ${first.width}: ` +
        "MySQL refuses a UNION whose branches are not the same width",
    );
    return;
  }
}

export const unionColumnCount: Rule = {
  id: "query/union-column-count",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `Two branches of a \`UNION\` that do not return the same number of columns.

MySQL refuses the statement, error 1222: *the used SELECT statements have a different number of
columns*. It is refused whenever the statement runs, so a union inside a procedure's error path
fails the day that path is taken.

It is what a column added to one branch and not the other leaves behind. A union is usually two
readings of the same shape — this month's rows and last month's, the open ones and the closed ones —
and they are edited one at a time.

**Counting is only possible because of the catalog.** \`SELECT a, t.* FROM t\` is three tokens to a
lexer and however many columns \`t\` has to the server, so a linter without a schema cannot compare
the two sides at all. Where a star cannot be resolved — a temporary table, a derived table, a
database this repo does not define — the width is unknown and the whole statement goes unjudged,
because this rule reports errors and does not get to guess.

\`EXCEPT\` and \`INTERSECT\` are read the same way: same rule, same error, same fix.

Each query's own depth is compared separately, so a \`UNION\` inside a derived table is checked
against its own siblings — the server refuses it there exactly as it does at the top.`,

  check(ctx) {
    checkRegion(ctx, ctx.statement);
    // Every parenthesised range is a region of its own: `FROM (SELECT … UNION SELECT …) x` holds a
    // union the statement's own depth never sees.
    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!punct(ctx.tokens[i], "(")) continue;
      const close = matchingParen(ctx.tokens, i);
      if (close !== -1 && close > i + 1) checkRegion(ctx, { from: i + 1, to: close - 1 });
    }
  },
};
