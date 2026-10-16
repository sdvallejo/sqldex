import { assignmentTargets } from "../shared/writes.ts";
import { declaresNoDataHandler, loops, type Loop } from "../shared/loops.ts";
import { foldsToOneRow, limitAt } from "../shared/rows.ts";
import { intoAt, intoList } from "../shared/selects.ts";
import { opensStatement } from "../../syntax/fast/stmt.ts";
import { kw, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

export const selectIntoStaleInLoop: Rule = {
  id: "routine/select-into-stale-in-loop",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A \`SELECT … INTO\` in a loop whose code then asks whether it found nothing, by testing the
variable for NULL — a test that, after the first pass, can never say yes.

When the query matches no row, MySQL does not clear the variables after \`INTO\`. It leaves them
exactly as they were and raises warning 1329, *No data - zero rows fetched, selected, or processed*,
which is a warning and stops nothing. Outside a loop that is mostly harmless: the variable still holds
what it was declared with. Inside one, it holds **another iteration's answer**, and the statements
that follow act on it as though it were this one's: a refund subtracted from an order that has none,
a status copied from the row before.

It is the kind of defect no test notices, because it needs a pass that finds nothing *after* one that
found something, and the data a procedure is written against rarely has both.

**What it reports is the loop that already expects a miss.** After the \`SELECT\`, the code tests the
variable with \`IS NULL\`, \`IS NOT NULL\`, \`<=> NULL\`, or hands it whole to \`COALESCE\`, \`IFNULL\`
or \`ISNULL\`: the author has said that *no row* is a case this loop meets, and is relying on a NULL to
recognise it. That NULL arrives on the first pass only. From the second on, \`IF v IS NULL THEN LEAVE\`
never leaves, and \`COALESCE(v, 0)\` never falls back to zero. Without such a test the rule has
nothing to go on: whether a lookup can miss is a fact about the data, and a plain read of a value
that is always found is not a defect.

Reported on each variable after \`INTO\` that is still carrying the previous pass's value at that
point, in the **innermost** loop the statement sits in. Setting the variable on every
pass — \`SET v = NULL\` above the \`SELECT\` in the loop body, or at its bottom — is the fix, and what
makes the rule go quiet.

What it deliberately leaves alone:

  - **A query that always returns a row**: an aggregate with no \`GROUP BY\`, which yields one row
    even over nothing, and a \`SELECT\` with no \`FROM\`.
  - **\`SELECT … INTO OUTFILE\` and \`INTO DUMPFILE\`**, which write a file and fill no variable.
  - **A \`@user\` variable.** It lives for the whole session and is often carried from one pass to the
    next on purpose; only the routine's own variables and parameters are reported.
  - **A variable assigned anywhere else in the same loop body**, by \`SET\`, by another \`SELECT …
    INTO\`, by \`FETCH … INTO\`, or by being handed to a \`CALL\`, which may fill it. Before the
    \`SELECT\` it is set afresh for this pass; after it, reset for the next. Any such assignment counts,
    even inside an \`IF\` branch: whether it runs on every pass is flow analysis this rule does not do.
  - **A walk by position**, \`LIMIT pIndex, 1\` or \`LIMIT 1 OFFSET pIndex\`: the loop reads the n-th
    row of a set it counted, and the pass that would find nothing is past the end, which the loop's own
    bound prevents.
  - **A variable declared inside the loop body**, which MySQL initialises again on every pass.
  - **A routine that declares a \`CONTINUE\` or \`EXIT\` handler for \`NOT FOUND\`, \`SQLSTATE '02000'\` or
    \`SQLWARNING\`.** The author is dealing with no data explicitly, and where the handler's effect on
    the variable lies is theirs to say.
  - **A variable nothing tests for NULL afterwards** in the rest of the loop body or its
    \`WHILE\`/\`UNTIL\` condition, including one inside a larger expression — \`COALESCE(v + 1, 0)\`
    asks about the sum, not about the variable.`,

  check(ctx) {
    const { tokens, body } = ctx;
    const found = loops(tokens, body);
    if (found.length === 0) return;
    if (declaresNoDataHandler(tokens, body)) return;

    const fold = (name: string, quoted: boolean): string => ctx.dialect.foldIdentifier(name, quoted);
    const locals = new Map<string, number[]>();
    for (const item of ctx.locals.items) {
      if (item.kind !== "variable" && item.kind !== "param") continue;
      const key = fold(item.name, item.quoted);
      const spans = locals.get(key) ?? [];
      spans.push(item.kind === "variable" ? item.nameSpan.s : -1);
      locals.set(key, spans);
    }
    if (locals.size === 0) return;

    const { written } = assignmentTargets(ctx);

    for (let sel = body.from; sel <= body.to; sel++) {
      if (!kw(tokens[sel], "SELECT") || !opensStatement(tokens, sel, body.from)) continue;

      // The innermost loop is the one opened latest among those that contain the statement.
      let loop: Loop | undefined;
      for (const candidate of found) {
        if (sel < candidate.body.from || sel > candidate.body.to) continue;
        if (!loop || candidate.body.from > loop.body.from) loop = candidate;
      }
      if (!loop) continue;

      let end = sel;
      while (end < body.to && !punct(tokens[end], ";")) end++;
      const stmtTo = punct(tokens[end], ";") ? end - 1 : end;

      const into = intoAt(tokens, sel, stmtTo);
      if (into === -1) continue;
      const list = intoList(tokens, into, stmtTo);
      if (!list) continue;
      if (foldsToOneRow(tokens, sel, stmtTo)) continue;
      if (!hasFrom(tokens, sel, stmtTo)) continue;
      if (walksByPosition(tokens, sel, stmtTo)) continue;

      const loopStart = tokens[loop.body.from]?.s ?? 0;
      const loopEnd = tokens[loop.end]!.s;

      for (const span of splitCommas(tokens, list.from, list.to)) {
        if (span.from !== span.to) continue;
        const target = tokens[span.from]!;
        if (target.t !== "id") continue;
        const key = fold(target.v, target.q === true);
        const spans = locals.get(key);
        if (!spans) continue;
        // A declaration inside the loop is fresh on every pass.
        if (spans.some((s) => s > loopStart && s < loopEnd)) continue;

        const same = (i: number): boolean => {
          const t = tokens[i];
          return t?.t === "id" && !punct(tokens[i - 1], ".") && fold(t.v, t.q === true) === key;
        };

        if (assignedElsewhere(tokens, loop.body, { from: sel, to: stmtTo }, same, written)) continue;

        // The rest of the body after this statement, and the condition, which runs between passes:
        // somewhere there the code has to ask whether the search found nothing.
        let tested = false;
        const scan = (from: number, to: number): void => {
          for (let i = from; i <= to && !tested; i++) {
            if (same(i) && !written.has(i) && testsForNull(tokens, i)) tested = true;
          }
        };
        scan(stmtTo + 1, loop.body.to);
        if (loop.condition) scan(loop.condition.from, loop.condition.to);
        if (!tested) continue;

        ctx.report(
          target,
          `if this SELECT finds no row, \`${target.v}\` keeps the value it had on the previous pass of the ` +
            "loop, so the NULL test after it cannot tell: the server leaves the variable unchanged and raises only a warning",
        );
      }
    }
  },
};

/** Functions whose whole point, given a variable as an argument, is to ask whether it is NULL. */
const NULL_TESTS: ReadonlySet<string> = new Set(["COALESCE", "IFNULL", "ISNULL"]);

/**
 * Is this read a question about NULL — `v IS [NOT] NULL`, `v <=> NULL`, or `v` as a whole argument
 * of `COALESCE`, `IFNULL` or `ISNULL`?
 *
 * A whole argument only: in `COALESCE(v + 1, 0)` the question is about the sum, which is NULL for
 * other reasons too.
 */
function testsForNull(tokens: readonly Token[], i: number): boolean {
  if (kw(tokens[i + 1], "IS")) {
    const at = kw(tokens[i + 2], "NOT") ? i + 3 : i + 2;
    if (kw(tokens[at], "NULL")) return true;
  }
  if (punct(tokens[i + 1], "<=>") && kw(tokens[i + 2], "NULL")) return true;

  const before = tokens[i - 1];
  const after = tokens[i + 1];
  if (!(punct(before, "(") || punct(before, ",")) || !(punct(after, ",") || punct(after, ")"))) return false;
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j]!;
    if (punct(t, ")")) depth++;
    else if (punct(t, "(")) {
      if (depth === 0) {
        const name = tokens[j - 1];
        return name?.t === "id" && !name.q && NULL_TESTS.has(name.v.toUpperCase());
      }
      depth--;
    } else if (punct(t, ";")) return false;
  }
  return false;
}

/** Does the query read from anything? A `SELECT` with no `FROM` is one row, always. */
function hasFrom(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "FROM")) return true;
  }
  return false;
}

/**
 * Is the query a walk by position — `LIMIT pIndex, 1`, `LIMIT 1 OFFSET pIndex`?
 *
 * Such a loop reads the n-th row of a set it counted, and the pass that would find nothing is the one
 * past the end, which the loop's own bound is there to prevent. Whether the rows come back in the same
 * order on every pass is `query/limit-offset-without-order-by`'s question.
 */
function walksByPosition(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "LIMIT")) return limitAt(tokens, i).offset;
  }
  return false;
}

/**
 * Is the variable written anywhere else in the loop body?
 *
 * Before the statement it is set afresh on this pass; after it, it is reset for the next one — a
 * `SET v = NULL` at the bottom of the body is as good a fix as one at the top. A write is a `SET` or
 * `INTO` target, or a mention in the arguments of a `CALL`, whose parameter may be `OUT`. Every
 * mention counts wherever it sits, `IF` branches included.
 */
function assignedElsewhere(
  tokens: readonly Token[],
  body: TokenRange,
  statement: TokenRange,
  same: (i: number) => boolean,
  written: ReadonlySet<number>,
): boolean {
  let inCall = false;
  for (let i = body.from; i <= body.to; i++) {
    if (i >= statement.from && i <= statement.to) continue;
    if (kw(tokens[i], "CALL") && opensStatement(tokens, i, body.from)) inCall = true;
    else if (punct(tokens[i], ";")) inCall = false;
    if (same(i) && (written.has(i) || inCall)) return true;
  }
  return false;
}
