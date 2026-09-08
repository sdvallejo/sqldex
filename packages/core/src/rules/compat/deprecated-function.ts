import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/**
 * Words after which a name is being **defined**, not called.
 *
 * `CREATE FUNCTION json_merge(...)` in a repo that ships its own is a declaration, and the one
 * place where the name followed by `(` is not a call of the built-in.
 */
const DEFINES: readonly string[] = ["FUNCTION", "PROCEDURE"];

export const deprecatedFunction: Rule = {
  id: "compat/deprecated-function",
  group: "compat",
  severity: "warn",
  scope: "document",
  dialects: ["mysql"],
  docs: `A call of a built-in the engine has already announced it will remove.

The server says this on every execution — \`JSON_MERGE\` answers with its result and a warning 1287
beside it — and nobody reads a client's warnings. So the notice arrives where it cannot be acted on,
once per run, forever, until the release that removes the function turns every procedure using it
into a deployment that fails. The finding says the same thing once, in the file, where the fix is.

What it flags is a call: the name, unquoted, followed by \`(\`. Which functions are deprecated, since
when and what replaces them is the dialect's own knowledge — the entry in its function catalogue —
rather than a list kept in this rule, so a function the manual retires later is one field on a
description that already exists.

**It stands down on anything that is not the built-in.** A qualified name (\`other_db.json_merge(x)\`)
belongs to whoever owns that schema; a name the project's own catalog holds as a routine is that
routine, whatever the engine calls its own; and a name after \`CREATE FUNCTION\` is the definition of
one. In each case the token is somebody's own name that happens to collide, and the engine's
deprecation says nothing about it.`,

  check(ctx) {
    const deprecated = new Map<string, { since: string; replacement?: string }>();
    for (const [name, fn] of ctx.dialect.functions) {
      if (fn.deprecated) deprecated.set(name, fn.deprecated);
    }
    if (deprecated.size === 0) return;

    ctx.tokens.forEach((token, i) => {
      if (token.t !== "id" || token.q) return;
      const notice = deprecated.get(token.v.toUpperCase());
      if (!notice) return;
      if (!punct(ctx.tokens[i + 1], "(")) return;

      const before = ctx.tokens[i - 1];
      if (punct(before, ".")) return;
      if (DEFINES.some((word) => kw(before, word))) return;
      if (ctx.catalog.routine(token.v)) return;

      const instead = notice.replacement ? `; use ${notice.replacement}` : "";
      ctx.report(token, `${token.v.toUpperCase()} is deprecated since MySQL ${notice.since}${instead}`);
    });
  },
};
