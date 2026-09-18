import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";

export interface IfStatement {
  /** Index of the control `IF` token itself. */
  ifIdx: number;
  /** Index of the `IF` in the closing `END IF`, i.e. one past the frame's `END`. */
  endIdx: number;
  /** Each arm's body, condition excluded — `THEN`/`ELSE` to the next separator or `END`. */
  branches: TokenRange[];
  /**
   * The condition leading into each arm, `IF`/`ELSEIF` up to its `THEN`, aligned with `branches`:
   * `conditions[k]` guards `branches[k]`. An `ELSE` arm has none, so with one there is one fewer.
   */
  conditions: TokenRange[];
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
export function isControlIf(tokens: readonly Token[], i: number): boolean {
  if (!punct(tokens[i + 1], "(")) return true;
  const close = matchingParen(tokens, i + 1);
  return close !== -1 && kw(tokens[close + 1], "THEN");
}

/** The words that may follow `END` to name what it closes, and must not be read as an opening. */
const CLOSERS = ["IF", "CASE", "WHILE", "LOOP", "REPEAT"] as const;

/**
 * Every `IF … [ELSEIF …]* [ELSE …] END IF` in `[from, to]`, innermost closed first.
 *
 * A single stack of open blocks (`BEGIN`, `IF`, `CASE`, `WHILE`, `LOOP`, `REPEAT`), all pushed
 * unconditionally except `IF`, all popped on the next `END` regardless of kind — nesting inside one
 * arm never reaches the enclosing `IF` frame, because whatever is nested is on top of the stack for
 * its own duration. An arm's range is a plain token span, so a `SET` inside a nested block still
 * counts as belonging to the arm that contains it. The word after `END` is part of the closing, not
 * a block of its own: read as one, `END IF` would open an `IF` that nothing ever closes, and every
 * `ELSE` after it would land on the wrong frame.
 */
export function ifStatements(tokens: readonly Token[], from: number, to: number): IfStatement[] {
  type Frame =
    | {
        kind: "if";
        ifIdx: number;
        condStart: number | undefined;
        armStart: number | undefined;
        branches: TokenRange[];
        conditions: TokenRange[];
      }
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
    else if (kw(t, "IF") && isControlIf(tokens, i)) {
      stack.push({ kind: "if", ifIdx: i, condStart: i + 1, armStart: undefined, branches: [], conditions: [] });
    } else if (kw(t, "THEN") && top?.kind === "if" && top.armStart === undefined) {
      if (top.condStart !== undefined) top.conditions.push({ from: top.condStart, to: i - 1 });
      top.condStart = undefined;
      top.armStart = i + 1;
    } else if (kw(t, "ELSEIF") && top?.kind === "if" && top.armStart !== undefined) {
      top.branches.push({ from: top.armStart, to: i - 1 });
      top.armStart = undefined;
      top.condStart = i + 1;
    } else if (kw(t, "ELSE") && top?.kind === "if" && top.armStart !== undefined) {
      top.branches.push({ from: top.armStart, to: i - 1 });
      top.armStart = i + 1;
    } else if (kw(t, "END")) {
      const frame = stack.pop();
      if (frame?.kind === "if") {
        if (frame.armStart !== undefined) frame.branches.push({ from: frame.armStart, to: i - 1 });
        if (kw(tokens[i + 1], "IF")) {
          found.push({ ifIdx: frame.ifIdx, endIdx: i + 1, branches: frame.branches, conditions: frame.conditions });
        }
      }
      if (CLOSERS.some((word) => kw(tokens[i + 1], word))) i++;
    }
  }
  return found;
}

/**
 * The conditions already known to hold, or to have failed, by the time `idx` runs.
 *
 * For every `IF` whose arm contains `idx`, at any depth: that arm's own condition, and the condition
 * of every arm before it in the same chain — reaching the third arm means the first two were asked and
 * answered no, which is as much a fact about their operands as the third arm's own yes.
 */
export function branchGuards(ifs: readonly IfStatement[], idx: number): TokenRange[] {
  const guards: TokenRange[] = [];
  for (const frame of ifs) {
    if (idx <= frame.ifIdx || idx >= frame.endIdx) continue;
    const arm = frame.branches.findIndex((b) => b.from <= idx && idx <= b.to);
    if (arm === -1) continue;
    guards.push(...frame.conditions.slice(0, arm + 1));
  }
  return guards;
}
