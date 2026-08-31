import { assignmentTargets } from "../shared/writes.ts";
import { matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Local } from "../../model/locals.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** The two functions where a two-argument call is provably equal to its other argument. */
const FALLBACK_FN: ReadonlySet<string> = new Set(["COALESCE", "IFNULL"]);

interface Tally {
  item: Local;
  written: boolean;
  reads: { token: Token; fn: string }[];
}

/**
 * Is `idx` a bare argument of an enclosing two-argument `COALESCE`/`IFNULL`, and if so which?
 *
 * Bare, not merely wrapped: `COALESCE(v + 1, 0)` is left for `routine/variable-never-assigned` to
 * stay quiet about, because `v + 1` is a claim about arithmetic NULL propagation this function does
 * not make. Two arguments, not `COALESCE`'s general N: with more than two, `v` sitting anywhere in
 * the list still can never win, but the result is no longer a single fixed "other argument" — it is
 * still whichever of the *remaining* ones comes first, which is a true but weaker thing to say than
 * this rule's message claims.
 */
function twoArgFallback(tokens: readonly Token[], idx: number): string | undefined {
  const prevOk = punct(tokens[idx - 1], "(") || punct(tokens[idx - 1], ",");
  const nextOk = punct(tokens[idx + 1], ",") || punct(tokens[idx + 1], ")");
  if (!prevOk || !nextOk) return undefined;

  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.t !== "punct") continue;
    if (t.v === ")") {
      depth++;
    } else if (t.v === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const name = tokens[i - 1];
      if (name?.t !== "id" || name.q) return undefined;
      const fn = name.v.toUpperCase();
      if (!FALLBACK_FN.has(fn)) return undefined;
      const close = matchingParen(tokens, i);
      if (close === -1) return undefined;
      const args: TokenRange[] = splitCommas(tokens, i + 1, close - 1);
      return args.length === 2 && args.some((a) => a.from === idx && a.to === idx) ? fn : undefined;
    } else if (t.v === ";" && depth === 0) {
      return undefined;
    }
  }
  return undefined;
}

export const deadCoalesceDefault: Rule = {
  id: "routine/dead-coalesce-default",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A never-assigned variable inside \`COALESCE\`/\`IFNULL\`, where the wrap does not make the read
safe — it makes the whole call pointless.

\`routine/variable-never-assigned\` stops at the wrapper: a read guarded by \`COALESCE\` is left alone
on the reasoning that a body which declares a variable it never sets and wraps every read of it is
deliberate, and correct. That reasoning holds when the variable is sometimes assigned on a path the
lexer cannot see and sometimes is not — the ordinary reason to reach for \`COALESCE\` at all. It
**does not hold** in this rule's scope, where nothing assigns the variable *anywhere in the routine*.
There is no path, seen or unseen, where it is not NULL. So \`COALESCE(v, x)\` and \`IFNULL(v, x)\` (or
\`x\` first) are not a guard against an occasional NULL; they always, unconditionally, evaluate to
\`x\` — the variable could be deleted and \`x\` written in its place with no change in behaviour. A
condition built on that call looks like it depends on the variable and never does.

**Two arguments only.** With three or more, \`v\` sitting anywhere in the list still can never win —
but the result is then whichever of the *other* arguments comes first, not a single fixed value, and
this rule's message is about a call collapsing to one exact answer. That is a true but weaker claim
for another rule to make later; this one stays where it can say something exact.

**The argument must be bare.** \`COALESCE(v + 1, 0)\` is left to \`routine/variable-never-assigned\`
(which also stays quiet about it, by the same wrapper reasoning) rather than guessed at here: whether
\`v + 1\` is provably NULL depends on arithmetic NULL propagation, a separate claim this rule does not
make.

Reported once, on the first such read — the same convention as \`routine/variable-never-assigned\`,
which this rule complements rather than duplicates: the two never report the same token, since a read
this rule catches is by definition one \`routine/variable-never-assigned\` was built to pass over.`,

  check(ctx) {
    const declared = new Map<string, Tally>();
    const order: string[] = [];
    for (const item of ctx.locals.items) {
      if (item.kind !== "variable" || item.default) continue;
      const key = ctx.dialect.foldIdentifier(item.name, item.quoted);
      if (!declared.has(key)) order.push(key);
      declared.set(key, { item, written: false, reads: [] });
    }
    if (order.length === 0) return;

    const { written, callOuts } = assignmentTargets(ctx);

    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      if (t.t !== "id" || t.q) return;
      const entry = declared.get(ctx.dialect.foldIdentifier(t.v, false));
      if (!entry || t.s === entry.item.nameSpan.s) return;
      if (written.has(i) || callOuts.has(i)) {
        entry.written = true;
        return;
      }
      const fn = twoArgFallback(ctx.tokens, i);
      if (fn) entry.reads.push({ token: t, fn });
    });

    for (const key of order) {
      const entry = declared.get(key)!;
      if (entry.written || entry.reads.length === 0) continue;
      const { token, fn } = entry.reads[0]!;
      ctx.report(
        token,
        `${entry.item.name} is never assigned, so it is always NULL; ${fn}(…) always evaluates to its other argument here`,
      );
    }
  },
};
