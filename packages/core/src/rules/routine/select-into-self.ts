import { selfAssignments } from "../shared/writes.ts";
import type { Rule } from "../rule.ts";

export const selectIntoSelf: Rule = {
  id: "routine/select-into-self",
  group: "routine",
  severity: "warn",
  scope: "statement",
  docs: `A variable selected into itself: \`SELECT … v … INTO … v …\` at matching positions, or
\`SET v = v\`.

Inside a routine a bare name resolves to the local variable before any column — even against a table
that has a column of exactly that name, and even written in backquotes. So the \`v\` in the select
list is never the column: it is the variable, copied back into itself, and the statement leaves it
exactly as it was. A variable declared without a \`DEFAULT\` stays NULL. The line reads like it
fetches a value and fetches nothing.

The usual cause is a column list typed next to its variable list, where the column that should have
been \`customer_id\` came out as \`v_customer_id\`. What follows is then quietly wrong: \`WHERE
customer_id != v_customer_id\` is unknown for every row, and a check built on it never fires.
\`routine/variable-never-assigned\` reports that later read when nothing else assigns the variable;
this rule reports the line that caused it, and also the case where the variable already held
something and the statement was meant to replace it.

What it deliberately leaves alone:

  - **A qualified name**, \`SELECT o.v INTO v\`: a qualifier is what makes it the column.
  - **A name that is not a local of the routine.** It is a column, and \`INTO\` cannot fill one anyway.
  - **Anything but a lone name on either side.** \`SET v = v + 1\` reads \`v\`; it does not hand it back.
  - **A \`SELECT … INTO\` whose column count does not match its variables**, which is
    \`routine/select-into-arity\`'s error: pairing positions that do not line up would be a guess.
  - **A \`UNION\`**, whose branches are separate select lists.`,

  check(ctx) {
    for (const pair of selfAssignments(ctx, ctx.statement)) {
      const token = ctx.tokens[pair.value]!;
      ctx.report(
        token,
        pair.form === "into"
          ? `\`${token.v}\` is selected into itself, so it keeps the value it had; qualify it if a column was meant`
          : `\`${token.v}\` is set to itself, so it keeps the value it had`,
      );
    }
  },
};
