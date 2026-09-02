/** Which mentions of a name write it rather than read it. */

import type { Routine } from "../../model/routine.ts";
import type { Token } from "../../syntax/types.ts";
import { kw, matchingParen, punct, qualifiedName, splitCommas } from "../../syntax/fast/tok.ts";
import type { BaseContext } from "../rule.ts";

export interface AssignmentTargets {
  /** Token indexes that are the destination of a `SET`, a `GET DIAGNOSTICS` or an `INTO`. */
  written: ReadonlySet<number>;
  /** Token indexes sitting in an `OUT`/`INOUT` argument of a `CALL`, which the callee fills in. */
  callOuts: ReadonlySet<number>;
}

/**
 * Walks a comma-separated `target = value` list starting at `from`, marking each target, and
 * returns the index it stopped at.
 *
 * Shared by the two statements written this way — `SET v = …` and `GET DIAGNOSTICS … v = …` — which
 * differ only in what precedes the list.
 */
function assignmentList(tokens: readonly Token[], from: number, written: Set<number>): number {
  let j = from;
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
  return j;
}

/**
 * Token indexes that **write** a local rather than read it.
 *
 * Three forms write one in the statement itself: `SET v = …`, with its comma-separated list, the
 * `INTO v1, v2` of a `SELECT … INTO` or a `FETCH … INTO`, and the `v = ITEM` list of a
 * `GET DIAGNOSTICS` — the last of which is how a `DECLARE … HANDLER` block gets at the error it just
 * caught, and reading it as anything but a write makes every such handler look like it is testing
 * variables nothing ever filled in. Telling a write from a read is the whole basis of the variable
 * rules — a variable that only ever appears as a destination is a variable nobody uses.
 *
 * A fourth form, an argument in an `OUT`/`INOUT` position of a `CALL`, comes back **separately**,
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
      i = assignmentList(tokens, i + 1, written) + 1;
    } else if (kw(tokens[i], "GET")) {
      // `GET [CURRENT | STACKED] DIAGNOSTICS [CONDITION n] v = ITEM, …` — the fourth form, and the
      // one a `DECLARE … HANDLER` block is written around. `GET_LOCK` is its own token, so testing
      // the bare word here does not catch it.
      let j = i + 1;
      if (kw(tokens[j], "CURRENT") || kw(tokens[j], "STACKED")) j++;
      if (kw(tokens[j], "DIAGNOSTICS")) {
        j++;
        // The condition number is **read**, never written: `GET DIAGNOSTICS CONDITION v_n v = …`
        // takes the number out of `v_n`, and marking it a write would make it look unused.
        if (kw(tokens[j], "CONDITION")) j += 2;
        i = assignmentList(tokens, j, written) + 1;
      } else {
        i = j;
      }
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
