import { branchGuards, ifStatements } from "./branches.ts";
import { nullableSources } from "./taint.ts";
import { assignmentTargets } from "./writes.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { RoutineContext } from "../rule.ts";

/** What absorbs the NULL before it reaches the comparison, and is therefore the fix. */
const ABSORBING: ReadonlySet<string> = new Set(["COALESCE", "IFNULL"]);

/**
 * The nearest enclosing function call, walking outwards, that has an opinion about a NULL.
 *
 * `CONCAT` is here for the opposite reason to the others: it does not absorb a NULL, it spreads one.
 * One NULL argument and the whole string is NULL — not the argument left out, not an empty string,
 * the entire result — so a tainted variable reaching one is the same defect wearing a different
 * coat. `CONCAT_WS` is not: it skips NULL arguments, which is what people reach for once bitten.
 */
function enclosing(tokens: readonly Token[], idx: number, limit: number): "absorbed" | "concat" | undefined {
  let depth = 0;
  for (let i = idx - 1; i >= limit; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") depth++;
    else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = tokens[i - 1];
      if (name?.t !== "id" || name.q) continue;
      const upper = name.v.toUpperCase();
      // The innermost opinion is the one that counts: in `CONCAT(COALESCE(v, ''), x)` the variable
      // never reaches the CONCAT as a NULL.
      if (ABSORBING.has(upper)) return "absorbed";
      if (upper === "CONCAT") return "concat";
    } else if (t.v === ";" && depth === 0) return undefined;
  }
  return undefined;
}

/** Folded names that `range` asks `IS NULL` or `IS NOT NULL` about. */
function nullTestedIn(ctx: RoutineContext, range: TokenRange): Set<string> {
  const { tokens, dialect } = ctx;
  const names = new Set<string>();
  for (let i = range.from; i <= range.to; i++) {
    const t = tokens[i]!;
    if (t.t !== "id" || t.q || !kw(tokens[i + 1], "IS")) continue;
    if (kw(tokens[i + 2], "NULL") || (kw(tokens[i + 2], "NOT") && kw(tokens[i + 3], "NULL"))) {
      names.add(dialect.foldIdentifier(t.v, false));
    }
  }
  return names;
}

/**
 * Variables the same statement also asks about directly, folded.
 *
 * `IF v IS NOT NULL AND v != x THEN` and `… WHERE t.c != v OR v IS NULL` are both somebody who
 * thought about it, and the second half of each is the finding this rule would otherwise make. One
 * `IS NULL` anywhere in the statement is taken as having handled it: the alternative is deciding
 * whether a particular `OR` covers a particular `AND`, which is a parse this backend does not do,
 * and being wrong about that would mean arguing with the author's own guard.
 */
function nullTested(ctx: RoutineContext): Map<number, Set<string>> {
  const byStatement = new Map<number, Set<string>>();
  for (const statement of ctx.statements()) {
    const names = nullTestedIn(ctx, statement);
    if (names.size > 0) byStatement.set(statement.from, names);
  }
  return byStatement;
}

export interface TaintedRead {
  readonly token: Token;
  readonly index: number;
  /** `table.column` the variable was filled from. */
  readonly origin: string;
  /** Set when the nearest opinionated call around the read is a `CONCAT`. */
  readonly wrapper: "concat" | undefined;
}

/**
 * Every read of a variable a nullable column filled, that nothing around it has already answered for.
 *
 * Shared by the rules that follow the taint of `routine/nullable-into-arithmetic` out through its
 * other exits, so they stand down on exactly the same things. A read is dropped when it is written
 * rather than read, qualified, compared with `<=>`, followed by `IS`, wrapped in `COALESCE`/`IFNULL`,
 * inside a statement that asks `IS [NOT] NULL` about it, or inside an `IF` arm whose own condition —
 * or the condition of an arm before it in the same chain — asks the same. The last one is the
 * statement convention extended to the block around the statement: `ELSEIF v IS NULL THEN` having
 * failed is how the arms after it know `v` is not NULL, and a `SET` inside one of them never repeats
 * the test.
 */
export function taintedReads(ctx: RoutineContext): TaintedRead[] {
  const tainted = nullableSources(ctx);
  if (tainted.size === 0) return [];

  const { written } = assignmentTargets(ctx);
  const { tokens, dialect } = ctx;
  const asked = nullTested(ctx);
  const statements = ctx.statements();
  const ifs = ifStatements(tokens, ctx.body.from, ctx.body.to);
  const guardCache = new Map<TokenRange, Set<string>>();
  const guardedBy = (range: TokenRange): Set<string> => {
    let names = guardCache.get(range);
    if (!names) guardCache.set(range, (names = nullTestedIn(ctx, range)));
    return names;
  };

  const reads: TaintedRead[] = [];
  let statement = 0;
  tokens.forEach((t, i) => {
    // Only this routine's body: a file can hold two, and one's variables are not the other's.
    if (i < ctx.body.from || i > ctx.body.to) return;
    while (statement < statements.length && statements[statement]!.to < i) statement++;

    if (t.t !== "id" || t.q || written.has(i) || punct(tokens[i - 1], ".")) return;
    const name = dialect.foldIdentifier(t.v, false);
    const origin = tainted.get(name);
    if (!origin) return;

    // `v <=> x` and `v IS [NOT] NULL` are the two ways of asking about the NULL on purpose.
    if ([tokens[i - 1], tokens[i + 1]].some((n) => n?.t === "punct" && n.v === "<=>")) return;
    if (kw(tokens[i + 1], "IS")) return;

    const here = statements[statement];
    if (here && here.from <= i && asked.get(here.from)?.has(name)) return;
    if (branchGuards(ifs, i).some((range) => guardedBy(range).has(name))) return;

    const wrapper = enclosing(tokens, i, here?.from ?? 0);
    if (wrapper === "absorbed") return;
    reads.push({ token: t, index: i, origin, wrapper });
  });
  return reads;
}
