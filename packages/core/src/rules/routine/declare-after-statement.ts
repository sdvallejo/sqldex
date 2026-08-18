import { kw, kwAny } from "../../syntax/fast/tok.ts";
import { punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/**
 * Words after `END` that close something which is not a block.
 *
 * `END IF`, `END WHILE`, `END LOOP`, `END REPEAT` and `END CASE` all end a *statement*, and reading
 * them as the end of the enclosing `BEGIN` would put the rest of the routine in the wrong block —
 * which is the only thing this rule has to get right.
 */
const NOT_A_BLOCK_END: ReadonlySet<string> = new Set(["IF", "WHILE", "LOOP", "REPEAT", "CASE"]);

export const declareAfterStatement: Rule = {
  id: "routine/declare-after-statement",
  group: "routine",
  severity: "error",
  scope: "document",
  docs: `A \`DECLARE\` after the block has started doing things.

MySQL wants every declaration at the top of its \`BEGIN … END\`, before the first statement. One that
arrives later is not a warning and not a slow path: the routine does not parse, error 1064, and the
\`CREATE PROCEDURE\` fails. The procedure that was there before it stays there, so what fails is the
deploy and not the application — usually at the least convenient moment.

It is the shape a variable added in a hurry takes. Somebody needs a counter halfway down a
two-hundred-line procedure and writes the \`DECLARE\` where the counter is used, which is where anybody
would write it in any other language.

**A server's own dump cannot contain this**, because the server would never have accepted the
routine. What it catches is the file somebody just edited — which is exactly when it is cheap to fix,
and the reason this is worth checking before a deploy rather than during one.

Each \`BEGIN\` opens a section of its own, so a declaration at the top of a nested block is where it
belongs and is not reported. And \`END IF\`, \`END WHILE\`, \`END LOOP\`, \`END REPEAT\` and \`END CASE\`
close statements rather than blocks, which is the one thing this has to read correctly.`,

  check(ctx) {
    const { tokens } = ctx;
    /** Whether each open block has run a statement yet, innermost last. */
    const blocks: boolean[] = [];
    let starting = false;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;

      if (kw(t, "BEGIN")) {
        blocks.push(false);
        starting = true;
        continue;
      }
      if (kw(t, "END")) {
        if (kwAny(tokens[i + 1], NOT_A_BLOCK_END) === undefined) blocks.pop();
        starting = false;
        continue;
      }
      if (punct(t, ";")) {
        starting = true;
        continue;
      }
      if (!starting || t.t !== "id") continue;
      starting = false;

      const depth = blocks.length - 1;
      if (depth < 0) continue;

      if (kw(t, "DECLARE")) {
        if (blocks[depth] === true) {
          ctx.report(t, "a DECLARE has to come before the block's first statement, or the routine does not parse");
        }
      } else {
        blocks[depth] = true;
      }
    }
  },
};
