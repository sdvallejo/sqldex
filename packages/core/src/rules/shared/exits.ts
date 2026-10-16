/**
 * A NULL check that does not let the routine carry on — the guard the taint rules have to believe.
 *
 * ```sql
 * SET v_customer = (SELECT customer_id FROM customers WHERE label = p_label);
 * IF v_customer IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'no such customer'; END IF;
 * ```
 *
 * From the line after that `END IF` the variable cannot be NULL, however far below it is read and
 * however many `IF` arms deep: the only way to get there with a NULL in it was through an arm that
 * left. `routine/nullable-variable-in-predicate` and its siblings follow a taint from where a
 * variable is filled to where it is read, and without this they report the read forty lines down as
 * though the check were not there. The per-statement and per-`IF`-arm guards in `null-guard.ts` look
 * at the read and its surroundings; this one works from the other end, the **source**, because the
 * guard's whole point is that it sits next to the source and the read does not need to repeat it.
 *
 * ## What clears a source
 *
 * A source (a `SET v = (SELECT …)`, a `SELECT … INTO v`) is cleared when, in its own block and before
 * the first mention of `v` after it, an `IF` follows whose **first** condition asks `v IS NULL` —
 * alone or joined only with `OR`, since `v IS NULL AND x` does not hold for every NULL — and whose
 * first arm always leaves. A variable is untainted only when **every** source of it is cleared: a
 * second, unchecked `SELECT … INTO v` reopens the question.
 *
 * ## What leaves
 *
 * The arm's **last** top-level statement being a `SIGNAL`, a `RESIGNAL`, a `RETURN`, or a `LEAVE` of
 * the label on the routine's outermost `BEGIN`. Not `ITERATE`, and not a `LEAVE` of an inner loop's
 * label: after the loop `v` can still be NULL, so the arm only leaves the loop, not the routine.
 * A nested `IF` as the last statement is not modelled as leaving, even if both its arms do.
 *
 * ## Where a `SIGNAL` does not leave
 *
 * With a `DECLARE CONTINUE HANDLER` in the routine that catches what the `SIGNAL` raises — for
 * `SQLEXCEPTION`, for the same `SQLSTATE`, or for a named condition or error number, which this
 * cannot resolve and so takes as catching — execution resumes at the next statement, so the guard
 * leaves nothing behind it. An `EXIT` handler does not change that: it ends the block, which is
 * leaving. A handler is taken to be in scope wherever in the routine it is declared; an inner
 * block's handler would only cover its own block, and treating it as covering all of them can only
 * keep a finding that a narrower reading would drop. A `SIGNAL` whose `SQLSTATE` is of class `01`
 * or `02` raises a warning or a not-found condition rather than an exception and is not an exit
 * either.
 */

import { kw, kwAny, punct, unquote } from "../../syntax/fast/tok.ts";
import { ifStatements, isControlIf, type IfStatement } from "./branches.ts";
import type { Dialect } from "../../dialects/dialect.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";

/** What this needs of a context. */
interface Scope {
  readonly tokens: readonly Token[];
  readonly body: TokenRange;
  readonly dialect: Dialect;
}

/** The words that open a block closed by an `END`. */
export const OPENERS: ReadonlySet<string> = new Set(["BEGIN", "CASE", "WHILE", "LOOP", "REPEAT"]);

/** The words that may follow `END` to name what it closes. */
export const CLOSERS: ReadonlySet<string> = new Set(["IF", "CASE", "WHILE", "LOOP", "REPEAT"]);

/** The object words an `IF [NOT] EXISTS` clause follows in DDL, which opens nothing. */
export const DDL_OBJECTS: ReadonlySet<string> = new Set([
  "TABLE", "VIEW", "INDEX", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT", "DATABASE", "SCHEMA", "COLUMN", "KEY",
  "USER", "ROLE", "SERVER", "SEQUENCE", "TABLESPACE", "RESOURCE", "SAVEPOINT",
]);

/**
 * How deep in blocks each token of the body sits: `before[k]` for the token at `body.from + k`, and
 * `after[k]` once that token's own opening or closing has been counted.
 *
 * One counter for `BEGIN`, `IF`, `CASE`, `WHILE`, `LOOP` and `REPEAT` alike, all closed by `END` —
 * the word after the `END` is part of the closing and counts for nothing. `IF(a, b, c)` the function,
 * `REPEAT(s, n)` the function and `DROP … IF EXISTS` open nothing.
 */
function depths(tokens: readonly Token[], body: TokenRange): { before: number[]; after: number[] } {
  const before: number[] = [];
  const after: number[] = [];
  let depth = 0;
  let skipCloser = false;
  for (let i = body.from; i <= body.to; i++) {
    const t = tokens[i]!;
    before.push(depth);
    if (skipCloser) {
      skipCloser = false;
      if (kwAny(t, CLOSERS) !== undefined) {
        after.push(depth);
        continue;
      }
    }
    if (t.t === "id" && !t.q) {
      const up = t.v.toUpperCase();
      const prev = tokens[i - 1];
      if (up === "IF") {
        const ddl = kw(tokens[i + 1], "EXISTS") || (kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS"));
        if (isControlIf(tokens, i) && !(ddl && prev?.t === "id" && DDL_OBJECTS.has(prev.v.toUpperCase()))) {
          depth++;
        }
      } else if (OPENERS.has(up) && !(up === "REPEAT" && punct(tokens[i + 1], "("))) {
        depth++;
      } else if (up === "END") {
        depth--;
        skipCloser = true;
      }
    }
    after.push(depth);
  }
  return { before, after };
}

/** The label on the routine's outermost `BEGIN`, folded, if it has one. */
function outerLabel(ctx: Scope): string | undefined {
  const { tokens, body } = ctx;
  for (let i = body.from; i <= body.to; i++) {
    if (!kw(tokens[i], "BEGIN")) continue;
    const label = tokens[i - 2];
    if (label?.t === "id" && punct(tokens[i - 1], ":")) return ctx.dialect.foldIdentifier(label.v, label.q === true);
    return undefined;
  }
  return undefined;
}

/** One condition a `CONTINUE` handler is declared for. */
type HandlerCondition = { kind: "exception" } | { kind: "never" } | { kind: "state"; state: string } | { kind: "other" };

/** Every condition of every `DECLARE CONTINUE HANDLER FOR` in the body. */
function continueHandlers(ctx: Scope): HandlerCondition[] {
  const { tokens, body } = ctx;
  const found: HandlerCondition[] = [];
  for (let i = body.from; i <= body.to; i++) {
    if (!kw(tokens[i], "DECLARE") || !kw(tokens[i + 1], "CONTINUE") || !kw(tokens[i + 2], "HANDLER")) continue;
    if (!kw(tokens[i + 3], "FOR")) continue;
    let j = i + 4;
    for (;;) {
      const t = tokens[j];
      if (kw(t, "SQLEXCEPTION")) {
        found.push({ kind: "exception" });
        j++;
      } else if (kw(t, "SQLWARNING")) {
        found.push({ kind: "never" });
        j++;
      } else if (kw(t, "NOT") && kw(tokens[j + 1], "FOUND")) {
        found.push({ kind: "never" });
        j += 2;
      } else if (kw(t, "SQLSTATE")) {
        j += kw(tokens[j + 1], "VALUE") ? 2 : 1;
        const state = tokens[j];
        found.push(state?.t === "str" ? { kind: "state", state: unquote(state.v).toUpperCase() } : { kind: "other" });
        j++;
      } else if (t && (t.t === "id" || t.t === "num")) {
        found.push({ kind: "other" });
        j++;
      } else break;
      if (punct(tokens[j], ",")) j++;
      else break;
    }
  }
  return found;
}

/**
 * Does a `SIGNAL`/`RESIGNAL` at `at` end the routine's progress?
 *
 * Not when it raises a warning or a not-found condition, and not when a `CONTINUE` handler in the
 * routine catches what it raises.
 */
function signalLeaves(tokens: readonly Token[], at: number, handlers: readonly HandlerCondition[]): boolean {
  let state: string | undefined;
  if (kw(tokens[at], "SIGNAL") && kw(tokens[at + 1], "SQLSTATE")) {
    const s = tokens[at + (kw(tokens[at + 2], "VALUE") ? 3 : 2)];
    if (s?.t === "str") state = unquote(s.v).toUpperCase();
  }
  if (state !== undefined && (state.startsWith("01") || state.startsWith("02"))) return false;

  return !handlers.some((h) => {
    if (h.kind === "never") return false;
    if (h.kind === "state") return state === undefined || h.state === state;
    return true;
  });
}

/**
 * Does this arm always leave the routine — is its last top-level statement one that does?
 *
 * `from`/`to` bound the arm; `level` is the depth its own statements sit at, so a `;` inside a nested
 * block does not end one of them.
 */
function armLeaves(
  ctx: Scope,
  arm: TokenRange,
  level: number,
  before: readonly number[],
  label: string | undefined,
  handlers: readonly HandlerCondition[],
): boolean {
  const { tokens, body } = ctx;
  let last: number | undefined;
  let fresh = true;
  for (let i = arm.from; i <= arm.to; i++) {
    if (before[i - body.from] !== level) {
      fresh = false;
      continue;
    }
    if (punct(tokens[i], ";")) {
      fresh = true;
      continue;
    }
    if (fresh) last = i;
    fresh = false;
  }
  if (last === undefined) return false;

  const verb = tokens[last]!;
  if (kw(verb, "RETURN")) return true;
  if (kw(verb, "SIGNAL") || kw(verb, "RESIGNAL")) return signalLeaves(tokens, last, handlers);
  if (kw(verb, "LEAVE")) {
    const target = tokens[last + 1];
    return (
      label !== undefined &&
      target?.t === "id" &&
      ctx.dialect.foldIdentifier(target.v, target.q === true) === label
    );
  }
  return false;
}

/** Does this `IF`'s first condition hold for every NULL `name`: `name IS NULL`, alone or with `OR`s? */
function asksNull(ctx: Scope, cond: TokenRange, name: string): boolean {
  const { tokens, dialect } = ctx;
  let asked = false;
  for (let i = cond.from; i <= cond.to; i++) {
    const t = tokens[i]!;
    if (kw(t, "AND") || kw(t, "XOR") || punct(t, "&&") || punct(t, "!")) return false;
    if (kw(t, "NOT") && !kw(tokens[i - 1], "IS")) return false;
    if (
      t.t === "id" &&
      !t.q &&
      !punct(tokens[i - 1], ".") &&
      dialect.foldIdentifier(t.v, false) === name &&
      kw(tokens[i + 1], "IS") &&
      kw(tokens[i + 2], "NULL")
    ) {
      asked = true;
    }
  }
  return asked;
}

/**
 * The folded names whose every source in `sites` is followed by a NULL check that leaves.
 *
 * `sites` maps a name to the token index of each place it is filled from a source of NULL.
 */
export function clearedByExit(ctx: Scope, sites: ReadonlyMap<string, readonly number[]>): Set<string> {
  const cleared = new Set<string>();
  if (sites.size === 0) return cleared;

  const { tokens, body, dialect } = ctx;
  const { before, after } = depths(tokens, body);
  const ifs = new Map<number, IfStatement>(ifStatements(tokens, body.from, body.to).map((f) => [f.ifIdx, f]));
  const label = outerLabel(ctx);
  const handlers = continueHandlers(ctx);

  for (const [name, at] of sites) {
    const every = at.every((site) => {
      const level = before[site - body.from];
      if (level === undefined) return false;
      for (let i = site + 1; i <= body.to; i++) {
        const k = i - body.from;
        // Out of the source's own block: the end of its arm, or the end of the block itself.
        if (after[k]! < level) return false;
        const t = tokens[i]!;
        if ((kw(t, "ELSE") || kw(t, "ELSEIF")) && before[k] === level) return false;

        const frame = ifs.get(i);
        if (frame && before[k] === level) {
          const cond = frame.conditions[0];
          const arm = frame.branches[0];
          if (cond && arm && asksNull(ctx, cond, name) && armLeaves(ctx, arm, level + 1, before, label, handlers)) {
            return true;
          }
        }
        // Any other mention of the variable is a read (or a rewrite) the check did not precede.
        if (t.t === "id" && !t.q && dialect.foldIdentifier(t.v, false) === name) return false;
      }
      return false;
    });
    if (every) cleared.add(name);
  }
  return cleared;
}
