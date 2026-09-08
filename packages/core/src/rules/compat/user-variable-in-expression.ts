import { kw, kwAny, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/**
 * Words a statement can begin right after, which is how a `SET` statement is told from the `SET`
 * clause of an `UPDATE`.
 *
 * `statements()` cuts on `;` and `BEGIN` only, so the `SET` of `IF x THEN SET @a := 1; END IF` sits
 * in the middle of its range rather than at its start — and reading only the first token of the
 * range would report the one assignment MySQL has no complaint about.
 */
const OPENS_STATEMENT: ReadonlySet<string> = new Set(["BEGIN", "THEN", "ELSE", "DO", "LOOP", "REPEAT"]);

/** Is the token a user variable — `@total`, and not the `@@session` of a system one? */
function userVariable(token: Token | undefined): token is Token {
  if (token === undefined || token.t !== "id" || token.q) return false;
  return token.v.startsWith("@") && !token.v.startsWith("@@");
}

/**
 * Every user variable that is the target of a `SET` **statement**, by token index.
 *
 * A target is what follows the `SET` itself or a comma at its own depth: `SET @a := 1, @b := 2`
 * assigns two of them, while the `@b` of `SET @a = (@b := 1) + 1` is nested in an expression and is
 * not a target at all — which is exactly the distinction the engine's warning draws.
 */
function setTargets(tokens: readonly Token[]): Set<number> {
  const targets = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const before = tokens[i - 1];
    const opens = i === 0 || punct(before, ";") || kwAny(before, OPENS_STATEMENT) !== undefined;
    if (!opens || !kw(tokens[i], "SET")) continue;

    let depth = 0;
    let expecting = true;
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (punct(token, "(")) depth++;
      else if (punct(token, ")")) depth--;
      else if (punct(token, ";") && depth === 0) break;
      else if (punct(token, ",") && depth === 0) {
        expecting = true;
        continue;
      }
      if (!expecting || depth !== 0) continue;
      if (userVariable(token)) targets.add(j);
      expecting = false;
    }
  }
  return targets;
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
      targets ??= setTargets(ctx.tokens);
      if (targets.has(i - 1)) continue;
      ctx.report(
        name,
        `assigning to ${name.v} outside a SET statement is deprecated; ` +
          `assign it with SET, or SELECT ... INTO ${name.v}`,
      );
    }
  },
};
