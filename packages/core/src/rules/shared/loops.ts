/**
 * Where a routine's loops are, and what the routine has said about a query that finds nothing.
 *
 * A loop is `WHILE … DO … END WHILE`, `REPEAT … UNTIL … END REPEAT` or `[label:] LOOP … END LOOP`. They
 * are found with the same single stack of blocks `exits.ts` and `branches.ts` count with — every
 * opener pushed, the next `END` popping whatever is on top, the word after `END` part of the closing —
 * so a loop nested in an `IF` in a `BEGIN` is matched to its own `END`, not to a neighbour's.
 */

import { kw, kwAny, punct, unquote } from "../../syntax/fast/tok.ts";
import { isControlIf } from "./branches.ts";
import { CLOSERS, DDL_OBJECTS, OPENERS } from "./exits.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";

export interface Loop {
  kind: "WHILE" | "REPEAT" | "LOOP";
  /** The `WHILE`, `REPEAT` or `LOOP` token. */
  open: number;
  /** The statements the loop repeats: after `DO` / `REPEAT` / `LOOP`, up to the `UNTIL` or the `END`. */
  body: TokenRange;
  /** The `WHILE` or `UNTIL` condition, which is evaluated once per pass and so reads variables too. */
  condition?: TokenRange;
  /** The `END` that closes it. */
  end: number;
}

/** Every loop in `[range.from, range.to]`, innermost closed first. */
export function loops(tokens: readonly Token[], range: TokenRange): Loop[] {
  interface Frame {
    kind: Loop["kind"] | "OTHER";
    open: number;
    bodyFrom: number;
    condition?: TokenRange;
    until?: number;
  }
  const found: Loop[] = [];
  const stack: Frame[] = [];
  let skipCloser = false;

  for (let i = range.from; i <= range.to; i++) {
    const t = tokens[i]!;
    if (skipCloser) {
      skipCloser = false;
      if (kwAny(t, CLOSERS) !== undefined) continue;
    }
    if (t.t !== "id" || t.q) continue;
    const up = t.v.toUpperCase();

    if (up === "IF") {
      const ddl = kw(tokens[i + 1], "EXISTS") || (kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS"));
      const prev = tokens[i - 1];
      if (isControlIf(tokens, i) && !(ddl && prev?.t === "id" && DDL_OBJECTS.has(prev.v.toUpperCase()))) {
        stack.push({ kind: "OTHER", open: i, bodyFrom: i });
      }
    } else if (up === "WHILE") {
      let depth = 0;
      let j = i + 1;
      for (; j <= range.to; j++) {
        if (punct(tokens[j], "(")) depth++;
        else if (punct(tokens[j], ")")) depth--;
        else if (depth === 0 && kw(tokens[j], "DO")) break;
      }
      stack.push({ kind: "WHILE", open: i, bodyFrom: j + 1, condition: { from: i + 1, to: j - 1 } });
    } else if (up === "REPEAT" && !punct(tokens[i + 1], "(")) {
      stack.push({ kind: "REPEAT", open: i, bodyFrom: i + 1 });
    } else if (up === "LOOP") {
      stack.push({ kind: "LOOP", open: i, bodyFrom: i + 1 });
    } else if (up === "UNTIL") {
      const top = stack[stack.length - 1];
      if (top?.kind === "REPEAT" && top.until === undefined) top.until = i;
    } else if (OPENERS.has(up)) {
      stack.push({ kind: "OTHER", open: i, bodyFrom: i });
    } else if (up === "END") {
      skipCloser = true;
      const frame = stack.pop();
      if (!frame || frame.kind === "OTHER") continue;
      const bodyTo = frame.until === undefined ? i - 1 : frame.until - 1;
      found.push({
        kind: frame.kind,
        open: frame.open,
        body: { from: frame.bodyFrom, to: bodyTo },
        condition: frame.until === undefined ? frame.condition : { from: frame.until + 1, to: i - 1 },
        end: i,
      });
    }
  }
  return found;
}

/**
 * Does the routine declare a handler that takes a query finding nothing into its own hands?
 *
 * A `CONTINUE` or `EXIT` handler for `NOT FOUND`, for `SQLSTATE '02000'` or for `SQLWARNING` — the
 * three ways of saying "no data" that `SELECT … INTO` raises. Any such handler, wherever in the
 * routine it is declared, counts: an inner block's handler covers only its own block, and taking it
 * as covering all of them can only keep a routine quiet, never make one noisy.
 */
export function declaresNoDataHandler(tokens: readonly Token[], range: TokenRange): boolean {
  for (let i = range.from; i <= range.to; i++) {
    if (!kw(tokens[i], "DECLARE")) continue;
    if (!kw(tokens[i + 1], "CONTINUE") && !kw(tokens[i + 1], "EXIT")) continue;
    if (!kw(tokens[i + 2], "HANDLER") || !kw(tokens[i + 3], "FOR")) continue;

    let j = i + 4;
    for (;;) {
      const t = tokens[j];
      if (kw(t, "SQLWARNING")) return true;
      if (kw(t, "NOT") && kw(tokens[j + 1], "FOUND")) return true;
      if (kw(t, "SQLSTATE")) {
        j += kw(tokens[j + 1], "VALUE") ? 2 : 1;
        const state = tokens[j];
        if (state?.t === "str" && unquote(state.v) === "02000") return true;
        j++;
      } else if (t && (t.t === "id" || t.t === "num")) {
        j++;
      } else break;
      if (punct(tokens[j], ",")) j++;
      else break;
    }
  }
  return false;
}
