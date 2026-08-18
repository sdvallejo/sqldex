import { BUILTIN_NAMES, SYSTEM_SCHEMAS } from "../shared/names.ts";
import type { Rule } from "../rule.ts";

export const unknownAlias: Rule = {
  id: "names/unknown-alias",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A qualifier in \`x.column\` that nothing in the statement declares.

**The distinction this rule rests on:** "I cannot tell which table this alias points at" and "that
alias does not exist" are different claims, and conflating them is what makes a rule like this
unusable. An alias the statement declares is never reported, even when what it points at could not
be resolved — that is the first case, and it is the engine's limitation rather than the code's
mistake. Only a qualifier nobody declared is the second.

Not reported: a server variable (\`@x.y\`, \`@@global.z\`), a schema name — recognised either as one of
the engine's own or because what follows the dot is a table the catalog has — a local, and a
temporary table from anywhere in the project.

The alias map is the innermost query scope's, not the statement's, because one statement can declare
the same letter twice for two different tables.`,

  check(ctx) {
    for (const dot of ctx.qualified) {
      const qualifierToken = ctx.tokens[dot - 1]!;
      const nameToken = ctx.tokens[dot + 1]!;
      const key = ctx.dialect.foldIdentifier(qualifierToken.v, qualifierToken.q ?? false);

      // `NEW.col` / `OLD.col`, and the trigger's own row: the column rule handles those.
      if (BUILTIN_NAMES.has(key)) continue;
      if (qualifierToken.v.startsWith("@")) continue;
      if (SYSTEM_SCHEMAS.has(key)) continue;
      // A schema qualifier, given away by what follows the dot being a catalog table.
      if (ctx.catalog.table(nameToken.v)) continue;

      if (ctx.aliasesFor(dot, key).has(key)) continue;
      if (ctx.locals.byName.has(key) || ctx.catalog.tempTable(qualifierToken.v)) continue;

      ctx.report(qualifierToken, `unknown alias: ${qualifierToken.v}`);
    }
  },
};
