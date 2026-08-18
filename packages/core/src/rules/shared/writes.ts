/** Which mentions of a name write it rather than read it. */

import type { Routine } from "../../model/routine.ts";
import { kw, matchingParen, punct, qualifiedName, splitCommas } from "../../syntax/fast/tok.ts";
import type { BaseContext } from "../rule.ts";

export interface AssignmentTargets {
  /** Token indexes that are the destination of a `SET` or an `INTO`. */
  written: ReadonlySet<number>;
  /** Token indexes sitting in an `OUT`/`INOUT` argument of a `CALL`, which the callee fills in. */
  callOuts: ReadonlySet<number>;
}

/**
 * Token indexes that **write** a local rather than read it.
 *
 * Two forms write one in the statement itself: `SET v = …`, with its comma-separated list, and the
 * `INTO v1, v2` of a `SELECT … INTO` or a `FETCH … INTO`. Telling a write from a read is the whole
 * basis of the variable rules — a variable that only ever appears as a destination is a variable
 * nobody uses.
 *
 * A third form, an argument in an `OUT`/`INOUT` position of a `CALL`, comes back **separately**,
 * because the two rules that need this disagree about it and both are right:
 *
 *   - To "never assigned, so this reads NULL" it is a write. `DECLARE v INT; CALL sp(x, v); … v …`
 *     is the ordinary way of getting a value out of a procedure, and counting that `v` as a read
 *     makes the rule accuse the idiom itself.
 *   - To "unused variable" it is **not** surplus. MySQL demands a variable in an `OUT` position
 *     whether the value is wanted or not, so a variable that exists purely to absorb one cannot be
 *     deleted — and greying out a name its author has no way of removing is worse than silence.
 *
 * The catalog has every signature with its parameter modes, so which argument is `OUT` is looked up
 * rather than guessed.
 */
export function assignmentTargets(ctx: BaseContext): AssignmentTargets {
  const { tokens, catalog } = ctx;
  const written = new Set<number>();
  const callOuts = new Set<number>();

  let i = 0;
  while (i < tokens.length) {
    if (kw(tokens[i], "SET")) {
      let j = i + 1;
      while (tokens[j]?.t === "id" && punct(tokens[j + 1], "=")) {
        written.add(j);

        // Skip the right-hand side, up to the comma that opens the next assignment. Reads in there
        // — the `v` of `SET v = v + 1` — stay reads, which is correct: the variable is used.
        let depth = 0;
        let k = j + 2;
        while (k < tokens.length) {
          const t = tokens[k]!;
          if (t.t === "punct") {
            if (t.v === "(") depth++;
            else if (t.v === ")") depth--;
            else if (depth === 0 && (t.v === ";" || t.v === ",")) break;
          }
          k++;
        }

        if (punct(tokens[k], ",")) j = k + 1;
        else break;
      }
      i = j + 1;
    } else if (kw(tokens[i], "INTO")) {
      // `INSERT INTO orders` comes through here and marks `orders`, which is harmless: only names
      // that are also declared locals are ever looked up in the result.
      let j = i + 1;
      while (tokens[j]?.t === "id") {
        written.add(j);
        if (punct(tokens[j + 1], ",")) j += 2;
        else break;
      }
      i = j + 1;
    } else if (kw(tokens[i], "CALL")) {
      const { name, nextIdx } = qualifiedName(tokens, i + 1);
      const routine: Routine | undefined = name ? catalog.routine(name) : undefined;
      if (routine?.params && punct(tokens[nextIdx], "(")) {
        const close = matchingParen(tokens, nextIdx);
        if (close !== -1 && close > nextIdx + 1) {
          splitCommas(tokens, nextIdx + 1, close - 1).forEach((span, slot) => {
            const param = routine.params[slot];
            // Only a lone identifier can be a destination. An expression in an `OUT` slot is a
            // different defect — the engine rejects it — and not these rules' business.
            if (param && param.mode !== "IN" && span.from === span.to && tokens[span.from]!.t === "id") {
              callOuts.add(span.from);
            }
          });
        }
        i = (close === -1 ? nextIdx : close) + 1;
      } else {
        i = nextIdx;
      }
    } else {
      i++;
    }
  }

  return { written, callOuts };
}
