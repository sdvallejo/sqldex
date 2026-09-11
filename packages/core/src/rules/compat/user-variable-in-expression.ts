import { punct } from "../../syntax/fast/tok.ts";
import { statementSetTargets } from "../shared/writes.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Is the token a user variable — `@total`, and not the `@@session` of a system one? */
function userVariable(token: Token | undefined): token is Token {
  if (token === undefined || token.t !== "id" || token.q) return false;
  return token.v.startsWith("@") && !token.v.startsWith("@@");
}

export const userVariableInExpression: Rule = {
  id: "compat/user-variable-in-expression",
  group: "compat",
  severity: "warn",
  scope: "document",
  dialects: ["mysql"],
  docs: `\`@variable := expression\` written anywhere other than a \`SET\` statement.

MySQL has announced it: assigning to a user variable in a statement that is not \`SET\` is supported
in 8.0 for backward compatibility and is subject to removal. The server answers every such statement
with a warning 1287, which is one line of a client's output nobody reads, so the notice keeps
arriving where it cannot be acted on until the release that removes the form turns the routine into
a syntax error.

There is a second reason to move the assignment out, and it bites before the removal does: the order
in which an expression's parts are evaluated is not guaranteed, so a statement that both writes and
reads the same variable — the running-total \`SELECT @n := @n + 1\` — has no defined answer and is
free to give a different one after an upgrade. \`SET\` first, or \`SELECT … INTO @n\`, says the same
thing in an order the engine commits to.

**Only \`:=\`, and only outside \`SET\`.** In a statement that is not \`SET\`, \`=\` is comparison, so
\`:=\` is the whole of the deprecated form. \`SET @a := 1\`, \`SET @a := 1, @b := 2\` and
\`SELECT MAX(total) INTO @n FROM orders\` are the forms the manual points at instead and are left
alone, as is \`@@session.sql_mode\`, which is a system variable and another subject entirely.`,

  check(ctx) {
    let targets: Set<number> | undefined;

    for (let i = 0; i < ctx.tokens.length; i++) {
      if (!punct(ctx.tokens[i], ":=")) continue;
      const name = ctx.tokens[i - 1];
      if (!userVariable(name)) continue;
      targets ??= statementSetTargets(ctx.tokens, 0, ctx.tokens.length - 1);
      if (targets.has(i - 1)) continue;
      ctx.report(
        name,
        `assigning to ${name.v} outside a SET statement is deprecated; ` +
          `assign it with SET, or SELECT ... INTO ${name.v}`,
      );
    }
  },
};
