import { intoAt, intoList, selectList, selectWidth } from "../shared/selects.ts";
import { kw, splitCommas } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const selectIntoArity: Rule = {
  id: "routine/select-into-arity",
  group: "routine",
  severity: "error",
  scope: "statement",
  supersedes: ["routine/select-into-many-rows"],
  docs: `A \`SELECT … INTO\` whose column count does not match the variables it fills.

MySQL answers error 1222, *The used SELECT statements have a different number of columns*, and the
procedure stops there. There is nothing to weigh up: the statement cannot succeed on any data, so
this is an error rather than a suspicion — which also makes it the one finding on such a line worth
reading, and why it displaces \`routine/select-into-many-rows\`. A statement that cannot run is not
going to run and return two rows.

**It is the same defect as \`query/insert-value-count\`, in the other place a list is filled
positionally**, and it goes wrong the same way: not when it is written, but when somebody later adds
a column to the \`SELECT\` and not a variable to the \`INTO\`, in a branch that may not run for months.

Both spellings are read, because these schemas contain both: \`SELECT a INTO v FROM t\` and
\`SELECT a FROM t INTO v\`.

**A \`*\` is counted, not skipped**, and that is the catalog earning its place: \`SELECT t.* INTO …\` is
one token to a lexer and however many columns \`t\` has to MySQL, and nothing but the schema turns one
into the other.

What it deliberately leaves alone:

  - **A star over anything the catalog does not hold** — a temporary table, a derived table, a
    database this repo does not define. The width is then unknown, and an error reported on a guess
    is worse than no error at all.
  - **\`SELECT … INTO OUTFILE\`**, which names a file rather than a list of variables.
  - **A \`UNION\`**, whose branches each have their own list and are checked by the engine against
    each other before any of this matters.`,

  check(ctx) {
    const { tokens } = ctx;
    const { from, to } = ctx.statement;
    if (!kw(tokens[from], "SELECT")) return;

    const into = intoAt(tokens, from, to);
    if (into === -1) return;

    const list = selectList(tokens, from, to);
    const targets = intoList(tokens, into, to);
    if (!list || !targets) return;

    // A `UNION` makes this two select lists, and MySQL has already compared them with each other.
    for (let i = from; i <= to; i++) {
      if (kw(tokens[i], "UNION")) return;
    }

    const width = selectWidth(ctx, list, from, to);
    if (width === undefined) return;

    const filled = splitCommas(tokens, targets.from, targets.to).length;
    if (width === filled) return;

    ctx.report(
      tokens[from]!,
      `this SELECT reads ${width} column(s) into ${filled} variable(s): ` +
        "MySQL answers error 1222 rather than filling them",
    );
  },
};
