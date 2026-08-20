import { assignmentTargets } from "../shared/writes.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Comparison operators where a NULL operand makes the whole comparison NULL. `<=>` is excluded on purpose: it is the operator built for exactly this case. */
const COMPARISON_OPS: ReadonlySet<string> = new Set(["=", "!=", "<>", "<", ">", "<=", ">="]);

interface IfStatement {
  /** Index of the control `IF` token itself. */
  ifIdx: number;
  /** Index of the `IF` in the closing `END IF`, i.e. one past the frame's `END`. */
  endIdx: number;
  /** Each arm's body, condition excluded — `THEN`/`ELSE` to the next separator or `END`. */
  branches: TokenRange[];
}

/**
 * Is this `IF` the control statement, not the `IF(a, b, c)` function?
 *
 * The function form always needs `(` immediately; the control form's condition may or may not be
 * parenthesized. So the only ambiguous shape is `IF (`, and that is resolved by looking past the
 * matching `)`: a `THEN` right there means control flow, anything else means the function used as a
 * value. This needs no context from the surrounding scan, unlike a flag that tracks "are we at the
 * start of a statement" — that kind of flag is fooled by a `CASE … WHEN a THEN IF(b,c,d) …` whose
 * inner `THEN` belongs to the `CASE`, not to an enclosing `IF`.
 */
function isControlIf(tokens: readonly Token[], i: number): boolean {
  if (!punct(tokens[i + 1], "(")) return true;
  const close = matchingParen(tokens, i + 1);
  return close !== -1 && kw(tokens[close + 1], "THEN");
}

/**
 * Every `IF … [ELSEIF …]* [ELSE …] END IF` in `[from, to]` with at least two arms.
 *
 * A single stack of open blocks (`BEGIN`, `IF`, `CASE`, `WHILE`, `LOOP`, `REPEAT`), all pushed
 * unconditionally except `IF`, all popped on the next `END` regardless of kind — nesting inside one
 * arm never reaches the enclosing `IF` frame, because whatever is nested is on top of the stack for
 * its own duration. An arm's range is a plain token span, so a `SET` inside a nested block still
 * counts as belonging to the arm that contains it.
 */
function ifStatements(tokens: readonly Token[], from: number, to: number): IfStatement[] {
  type Frame =
    | { kind: "if"; ifIdx: number; armStart: number | undefined; branches: TokenRange[] }
    | { kind: "begin" | "case" | "while" | "loop" | "repeat" };
  const stack: Frame[] = [];
  const found: IfStatement[] = [];

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (t.t !== "id" || t.q) continue;
    const top = stack[stack.length - 1];

    if (kw(t, "CASE")) stack.push({ kind: "case" });
    else if (kw(t, "BEGIN")) stack.push({ kind: "begin" });
    else if (kw(t, "WHILE")) stack.push({ kind: "while" });
    else if (kw(t, "LOOP")) stack.push({ kind: "loop" });
    else if (kw(t, "REPEAT")) stack.push({ kind: "repeat" });
    else if (kw(t, "IF") && isControlIf(tokens, i)) stack.push({ kind: "if", ifIdx: i, armStart: undefined, branches: [] });
    else if (kw(t, "THEN") && top?.kind === "if" && top.armStart === undefined) top.armStart = i + 1;
    else if (kw(t, "ELSEIF") && top?.kind === "if" && top.armStart !== undefined) {
      top.branches.push({ from: top.armStart, to: i - 1 });
      top.armStart = undefined;
    } else if (kw(t, "ELSE") && top?.kind === "if" && top.armStart !== undefined) {
      top.branches.push({ from: top.armStart, to: i - 1 });
      top.armStart = i + 1;
    } else if (kw(t, "END")) {
      const frame = stack.pop();
      if (frame?.kind === "if") {
        if (frame.armStart !== undefined) frame.branches.push({ from: frame.armStart, to: i - 1 });
        if (kw(tokens[i + 1], "IF") && frame.branches.length >= 2) {
          found.push({ ifIdx: frame.ifIdx, endIdx: i + 1, branches: frame.branches });
        }
      }
    }
  }
  return found;
}

/** Folded name of an unqualified identifier read, or `undefined` for anything else. */
function readName(tokens: readonly Token[], dialect: { foldIdentifier(name: string, quoted: boolean): string }, i: number): string | undefined {
  const t = tokens[i];
  if (!t || t.t !== "id" || t.q || punct(tokens[i - 1], ".")) return undefined;
  return dialect.foldIdentifier(t.v, false);
}

export const exclusiveBranchAnd: Rule = {
  id: "routine/exclusive-branch-and",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `Two variables set in different, mutually exclusive branches of one \`IF\`, later asked about
together with \`AND\`.

A \`DECLARE\` with no \`DEFAULT\` starts as NULL. When an \`IF\`/\`ELSEIF\`/\`ELSE\` gives two such
variables to two different arms — one variable per arm, never the same arm for both — at most one of
them is ever non-NULL once the \`IF\` finishes: whichever arm did not run left its variable NULL. A
later \`v1 = x AND v2 = y\` then always has a NULL operand on one side or the other, and \`NULL AND
anything-but-FALSE\` is NULL, which MySQL reads as false. **The condition can never be true.** It is
easy to miss because each half of it — \`v1 = x\`, \`v2 = y\` — looks correct on its own; the defect
is only visible against the \`IF\` that produced them, which is why the rule has to see both.

The usual origin is two variables standing in for "which path did this take", one per branch, meant
to be asked about with \`OR\` (any path failed) and instead asked about with \`AND\` (every path
failed at once, which cannot happen when only one path ever runs).

What it deliberately leaves alone:

  - **A write to either variable between the \`IF\` and the check.** An unconditional \`SET v1 =
    COALESCE(v1, 0)\` right after the \`IF\` is exactly the fix, and reading past it would accuse the
    fix itself.
  - **An \`IS NULL\`/\`IS NOT NULL\` test on either variable, anywhere in the same statement** — the
    same convention \`routine/nullable-variable-in-predicate\` uses: one such test is taken as having
    thought about the NULL on purpose.
  - **\`<=>\`**, the NULL-safe equality built for exactly this comparison.
  - **A single-branch \`IF\` with no \`ELSE\`/\`ELSEIF\`.** There is no second, named arm for a
    partner variable to be exclusive against.
  - **The whole \`AND\` wrapped in \`NOT\`.** That negation flips which claim is being made, and is a
    different rule's business, not this one's.

**What it does not model:** only a single-token right-hand side is matched — \`v1 = 0\`, not \`v1 =
pOther + 1\` — because finding the end of an arbitrary expression is a different scanner than this
rule needs to earn its keep. That is a false negative, the only direction of error this rule accepts:
it can miss a wider version of the same defect, and in return it is never wrong about the one it
reports.`,

  check(ctx) {
    const { tokens, dialect } = ctx;
    const ifs = ifStatements(tokens, ctx.body.from, ctx.body.to);
    if (ifs.length === 0) return;

    const candidates = new Set<string>();
    for (const item of ctx.locals.items) {
      if (item.kind === "variable" && !item.default) candidates.add(dialect.foldIdentifier(item.name, item.quoted));
    }
    if (candidates.size === 0) return;

    const { written, callOuts } = assignmentTargets(ctx);
    const isWrite = (i: number): boolean => written.has(i) || callOuts.has(i);

    /** Every write to a candidate variable, by folded name, sorted by token index. */
    const writesByName = new Map<string, number[]>();
    for (const i of new Set([...written, ...callOuts])) {
      const name = readName(tokens, dialect, i);
      if (!name || !candidates.has(name)) continue;
      const list = writesByName.get(name) ?? [];
      list.push(i);
      writesByName.set(name, list);
    }
    for (const list of writesByName.values()) list.sort((a, b) => a - b);

    const writesBetween = (name: string, from: number, to: number): boolean =>
      (writesByName.get(name) ?? []).some((i) => i > from && i < to);

    const statements = ctx.statements();
    const nullTestedIn = (range: TokenRange, name: string): boolean => {
      for (let i = range.from; i <= range.to; i++) {
        const t = tokens[i]!;
        if (t.t !== "id" || t.q || dialect.foldIdentifier(t.v, false) !== name) continue;
        if (!kw(tokens[i + 1], "IS")) continue;
        if (kw(tokens[i + 2], "NULL") || (kw(tokens[i + 2], "NOT") && kw(tokens[i + 3], "NULL"))) return true;
      }
      return false;
    };

    for (const frame of ifs) {
      // Which candidate variables each arm writes, and which arms write each one.
      const armsOf = new Map<string, Set<number>>();
      frame.branches.forEach((arm, armIdx) => {
        for (let i = arm.from; i <= arm.to; i++) {
          if (!isWrite(i)) continue;
          const name = readName(tokens, dialect, i);
          if (!name || !candidates.has(name)) continue;
          // A write before this IF means the variable did not start NULL at the IF, so it cannot
          // anchor an exclusivity claim — check once per (name, arm) pair, cheap either way.
          if (writesByName.get(name)?.some((w) => w < frame.ifIdx)) continue;
          const set = armsOf.get(name) ?? new Set<number>();
          set.add(armIdx);
          armsOf.set(name, set);
        }
      });

      const names = [...armsOf.keys()];
      for (let a = 0; a < names.length; a++) {
        for (let b = a + 1; b < names.length; b++) {
          const v1 = names[a]!;
          const v2 = names[b]!;
          const arms1 = armsOf.get(v1)!;
          const arms2 = armsOf.get(v2)!;
          let disjoint = true;
          for (const armIdx of arms1) {
            if (arms2.has(armIdx)) {
              disjoint = false;
              break;
            }
          }
          if (!disjoint) continue;

          for (let k = frame.endIdx + 1; k <= ctx.body.to; k++) {
            if (!kw(tokens[k], "AND")) continue;

            const leftVar = k - 3;
            const leftOp = tokens[k - 2];
            const leftRhs = tokens[k - 1];
            const rightVar = k + 1;
            const rightOp = tokens[k + 2];
            const rightRhs = tokens[k + 3];
            if (!leftOp || !COMPARISON_OPS.has(leftOp.v) || leftOp.t !== "punct") continue;
            if (!leftRhs || !["num", "str", "id"].includes(leftRhs.t)) continue;
            if (!rightOp || !COMPARISON_OPS.has(rightOp.v) || rightOp.t !== "punct") continue;
            if (!rightRhs || !["num", "str", "id"].includes(rightRhs.t)) continue;

            const leftName = readName(tokens, dialect, leftVar);
            const rightName = readName(tokens, dialect, rightVar);
            if (!leftName || !rightName) continue;
            const pairMatches = (leftName === v1 && rightName === v2) || (leftName === v2 && rightName === v1);
            if (!pairMatches) continue;

            // `NOT (v1 = x AND v2 = y)` makes the opposite claim — a different rule's business.
            let p = leftVar - 1;
            while (punct(tokens[p], "(")) p--;
            if (kw(tokens[p], "NOT")) continue;

            if (writesBetween(v1, frame.endIdx, leftVar) || writesBetween(v2, frame.endIdx, leftVar)) continue;

            const statement = statements.find((s) => s.from <= k && k <= s.to);
            if (statement && (nullTestedIn(statement, v1) || nullTestedIn(statement, v2))) continue;

            ctx.report(
              tokens[leftVar]!,
              `${tokens[leftVar]!.v} and ${tokens[rightVar]!.v} are set in different branches of the same IF — ` +
                "at most one is ever non-NULL, so this AND can never be true",
            );
          }
        }
      }
    }
  },
};
