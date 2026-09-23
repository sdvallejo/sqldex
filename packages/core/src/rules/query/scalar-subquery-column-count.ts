/**
 * A `( SELECT … )` read where a single value is expected, whose own select list has more than one
 * column.
 */

import { statementSetTargets } from "../shared/writes.ts";
import { assignments } from "../shared/written.ts";
import { setClause } from "../shared/columns.ts";
import { selectList, subqueryWidth } from "../shared/selects.ts";
import { ARITHMETIC } from "../shared/nulls.ts";
import { kw, kwAny, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule, ScopeInfo, StatementContext } from "../rule.ts";

/** Words immediately before the subquery's own `(` that say it is not read as one value. */
const NOT_A_VALUE: ReadonlySet<string> = new Set(["EXISTS", "IN", "ANY", "SOME", "ALL"]);

/** Keyword spellings of an arithmetic operator, alongside the punctuation ones in `ARITHMETIC`. */
const ARITH_KEYWORDS: ReadonlySet<string> = new Set(["DIV", "MOD"]);

/** The comparisons that take one value on each side — unless both sides turn out to be rows. */
const COMPARISON_OPS: ReadonlySet<string> = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "<=>"]);

/** The three operators that make a subquery's arity `query/union-column-count`'s business instead. */
const SET_OPERATORS: ReadonlySet<string> = new Set(["UNION", "EXCEPT", "INTERSECT"]);

/** Is this `( SELECT … )` a derived table of the query around it, rather than a value in it? */
function isDerivedTable(ctx: StatementContext, open: number): boolean {
  let scope: ScopeInfo | undefined = ctx.scopeAt(open);
  while (scope) {
    if (scope.relations.some((relation) => relation.derived?.from === open)) return true;
    scope = scope.parent;
  }
  return false;
}

/** Is there a `UNION`/`EXCEPT`/`INTERSECT` at this subquery's own depth? */
function hasOwnSetOperator(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kwAny(t, SET_OPERATORS) !== undefined) return true;
  }
  return false;
}

/** The `(` matching a given `)` — `matchingParen` in `tok.ts` goes the other direction. */
function matchingParenOpen(tokens: readonly Token[], closeIdx: number): number {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The nearest `(` that encloses `idx` without a matching `)` in between — skipping whole, balanced
 * groups along the way, which is what tells `COALESCE(f(1, 2), (SELECT …))`'s subquery apart from an
 * argument of `f` rather than of `COALESCE`.
 */
function enclosingOpen(tokens: readonly Token[], idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The end of a `SET` assignment's right-hand side starting at `from`, its terminator excluded. */
function assignmentValueEnd(tokens: readonly Token[], from: number, to: number): number {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && (punct(t, ",") || punct(t, ";"))) return i - 1;
  }
  return to;
}

/**
 * Is `[open, close]` the entire right-hand side of one assignment of a statement-level `SET v =
 * (…), v2 = (…)`, or of an `UPDATE`'s `SET col = (…)`?
 */
function isAssignmentRhs(ctx: StatementContext, open: number, close: number): boolean {
  const { tokens, statement } = ctx;
  if (kw(tokens[statement.from], "SET")) {
    for (const idx of statementSetTargets(tokens, statement.from, statement.to)) {
      if (!punct(tokens[idx + 1], "=")) continue;
      const from = idx + 2;
      if (from === open && assignmentValueEnd(tokens, from, statement.to) === close) return true;
    }
    return false;
  }
  if (kw(tokens[statement.from], "UPDATE")) {
    const set = setClause(ctx);
    if (set.from === -1) return false;
    return assignments(tokens, set.from + 1, set.to - 1).some(
      (pair) => pair.value.from === open && pair.value.to === close,
    );
  }
  return false;
}

/** Is the subquery an operand of `+ - * / %`, `DIV` or `MOD`, on either side? */
function isArithmeticOperand(tokens: readonly Token[], open: number, close: number): boolean {
  const isArith = (t: Token | undefined): boolean =>
    (t?.t === "punct" && ARITHMETIC.has(t.v)) || kwAny(t, ARITH_KEYWORDS) !== undefined;
  return isArith(tokens[open - 1]) || isArith(tokens[close + 1]);
}

/** Is `[open, close]` an argument of a function call — the first, or one after a comma? */
function isFunctionArgument(tokens: readonly Token[], open: number): boolean {
  const fnOpen = enclosingOpen(tokens, open);
  if (fnOpen === -1) return false;
  const name = tokens[fnOpen - 1];
  return name?.t === "id" && !name.q;
}

/**
 * Is `[open, close]` exactly one item of some other `SELECT`'s list in this statement — its own
 * `SELECT` excluded — optionally followed by an alias?
 */
function isSelectListItem(ctx: StatementContext, open: number, close: number): boolean {
  const { tokens, statement } = ctx;
  for (let i = statement.from; i <= statement.to; i++) {
    if (!kw(tokens[i], "SELECT") || i === open + 1) continue;
    const list = selectList(tokens, i, statement.to);
    if (!list) continue;
    for (const item of splitCommas(tokens, list.from, list.to)) {
      if (item.from !== open) continue;
      if (item.to === close) return true;
      if (item.to === close + 1 && tokens[close + 1]?.t === "id") return true;
      if (item.to === close + 2 && kw(tokens[close + 1], "AS") && tokens[close + 2]?.t === "id") return true;
    }
  }
  return false;
}

/**
 * Is `[pOpen, pClose]` — the other side of a comparison — itself a row: a parenthesised list of
 * more than one item, or a subquery whose own width the catalog says is more than one, or cannot
 * say at all?
 *
 * The last case is deliberate: a comparison against a subquery of unknown width might be a row
 * comparison this rule cannot rule out, and reporting on a guess is worse than staying quiet.
 */
function isRowSide(ctx: StatementContext, pOpen: number, pClose: number): boolean {
  const { tokens } = ctx;
  if (kw(tokens[pOpen + 1], "SELECT")) {
    const width = subqueryWidth(ctx, pOpen, pClose);
    return width === undefined || width > 1;
  }
  return splitCommas(tokens, pOpen + 1, pClose - 1).length > 1;
}

/** Is the subquery one side of a comparison whose other side is not itself a row? */
function isComparisonOperand(ctx: StatementContext, open: number, close: number): boolean {
  const { tokens } = ctx;
  const before = tokens[open - 1];
  if (before?.t === "punct" && COMPARISON_OPS.has(before.v)) {
    const other = tokens[open - 2];
    if (punct(other, ")")) {
      const otherOpen = matchingParenOpen(tokens, open - 2);
      if (otherOpen !== -1 && isRowSide(ctx, otherOpen, open - 2)) return false;
    }
    return true;
  }
  const after = tokens[close + 1];
  if (after?.t === "punct" && COMPARISON_OPS.has(after.v)) {
    const other = tokens[close + 2];
    if (punct(other, "(")) {
      const otherClose = matchingParen(tokens, close + 2);
      if (otherClose !== -1 && isRowSide(ctx, close + 2, otherClose)) return false;
    }
    return true;
  }
  return false;
}

/** Is this subquery sitting somewhere MySQL demands a single value? */
function isScalarPosition(ctx: StatementContext, open: number, close: number): boolean {
  return (
    isAssignmentRhs(ctx, open, close) ||
    isArithmeticOperand(ctx.tokens, open, close) ||
    isFunctionArgument(ctx.tokens, open) ||
    isSelectListItem(ctx, open, close) ||
    isComparisonOperand(ctx, open, close)
  );
}

export const scalarSubqueryColumnCount: Rule = {
  id: "query/scalar-subquery-column-count",
  group: "query",
  severity: "error",
  scope: "statement",
  // Both can land on the subquery's own SELECT, and this is the stronger claim: a wrong column
  // count fails on every execution of the line, whether or not the data happens to match several
  // rows or the aggregate happens to answer NULL — the way `routine/select-into-arity` displaces
  // `routine/select-into-many-rows` for the same reason.
  supersedes: ["query/nullable-scalar-subquery", "query/scalar-subquery-many-rows"],
  docs: `A scalar subquery — one read where a single value is expected — whose own select list has
more than one column.

\`CREATE PROCEDURE\` accepts \`SET v_total = (SELECT SUM(amount), 0 FROM order_lines WHERE order_id =
p_order_id)\` without complaint: the column count of a subquery is not checked until the statement
runs. MySQL then answers error 1241, *Operand should contain 1 column(s)*; MariaDB answers 4078,
naming the variable or operator that could not take a row. Either way, the first place anybody finds
out is whichever branch reaches the line, and a branch that is rarely exercised can hide it for
months.

It reports the same shape wherever MySQL only accepts one value: the right-hand side of a
statement-level \`SET v = (…)\` and of an \`UPDATE\`'s \`SET col = (…)\`, an operand of \`+ - * / %\`,
\`DIV\` or \`MOD\`, one side of \`= != <> < > <= >= <=>\` whose other side is not itself a row, an item
of an outer select list, and an argument of a function call.

**A \`*\` is counted through the catalog**, the same as \`routine/select-into-arity\`: \`(SELECT * FROM
t)\` is one token to a lexer and however many columns \`t\` has to the server, and nothing but the
schema can turn the first into the second. Where the star cannot be resolved — a temporary table, a
derived table, a database this repo does not define — the width is unknown, and this rule stays
quiet rather than guess.

What it deliberately leaves alone:

  - **\`EXISTS\`/\`NOT EXISTS\`**, which asks only whether a row exists and has an answer for the empty
    case regardless of what the select list holds.
  - **A derived table**, \`FROM (SELECT …) x\` or \`JOIN (SELECT …) x\`, which is a query and not a
    value.
  - **\`IN\`/\`NOT IN\` and \`ANY\`/\`SOME\`/\`ALL\`.** Their subquery may return several rows, and
    its width has to match the left-hand side, which may itself be a row. This rule does not compare
    the two, so a mismatch there goes unreported rather than guessed at.
  - **A row comparison**, \`(a, b) = (SELECT a, b FROM t)\` or \`(a, b) IN (SELECT a, b FROM t)\`:
    MySQL accepts a row on one side of \`=\` when the other side is also a row, and this is what that
    idiom looks like — both sides read together, not one value against several.
  - **\`INSERT … SELECT\`, \`CREATE TABLE … AS SELECT\`, and a bare top-level \`SELECT\`**, none of
    which read the query as a single value, so several columns is the ordinary case rather than a
    defect.
  - **A \`UNION\` inside the subquery, at its own depth** — a mismatch between its branches is
    \`query/union-column-count\`'s finding, not this one's.`,

  check(ctx) {
    const { tokens, statement } = ctx;

    for (let i = statement.from; i <= statement.to; i++) {
      if (!punct(tokens[i], "(") || !kw(tokens[i + 1], "SELECT")) continue;
      const close = matchingParen(tokens, i);
      if (close === -1 || close > statement.to) continue;

      if (kwAny(tokens[i - 1], NOT_A_VALUE) !== undefined) continue;
      if (isDerivedTable(ctx, i)) continue;
      if (hasOwnSetOperator(tokens, i + 1, close - 1)) continue;

      const width = subqueryWidth(ctx, i, close);
      if (width === undefined || width <= 1) continue;

      if (!isScalarPosition(ctx, i, close)) continue;

      ctx.report(
        tokens[i + 1]!,
        `this subquery is used as one value but selects ${width} columns: ` +
          "MySQL answers error 1241 (MariaDB 4078) when the line runs",
      );
    }
  },
};
