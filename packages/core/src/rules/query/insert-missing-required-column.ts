import { insertTarget } from "../shared/inserts.ts";
import type { Rule } from "../rule.ts";

export const insertMissingRequiredColumn: Rule = {
  id: "query/insert-missing-required-column",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `An \`INSERT\` whose column list leaves out a column the table requires.

A column is required when it is \`NOT NULL\` and the engine has nothing to put there on its own: no
\`DEFAULT\`, not \`AUTO_INCREMENT\`, not generated. Omitting one is error 1364 — *Field 'x' doesn't have
a default value* — under the strict mode that has been the default since 5.7.

It is the other half of the failure \`query/insert-value-count\` catches, and it arrives the same way:
a table gains a \`NOT NULL\` column, and every insert that named its columns is now wrong. The
difference is which inserts break. A positional insert breaks all at once and loudly, because the
count no longer matches; one with a column list keeps deploying and keeps parsing, and fails at run
time in whichever procedure nobody thought to look at.

Which is also why it earns most of its keep before a deploy rather than during one. An insert
missing a required column fails the first time it runs, so the ones left in a repository of code
that already runs are the ones that have **not** run yet — a migration, a seed, a script written
this morning.

**Only with an explicit column list.** Without one the insert supplies every column by position, and
whether that is right is a question about the count — which is a different rule's. \`INSERT ... SET\`
is not read here either: it is a third syntax, and reading it wrongly would invent missing columns
out of an assignment list.

**An empty parenthesis is not a column list**, and a list holding a name the table does not have is
not one this rule can read. The first names nothing, so nothing can be missing from it —
\`INSERT INTO t () SELECT …\` is a positional insert with an empty pair of brackets in front of it.
The second is describing some other shape, and \`query/insert-unknown-column\` reports that statement
already; adding that it is also missing things would be a second message about one defect.

**A \`TIMESTAMP\` with no \`DEFAULT\` written is not treated as required.** MySQL may give the first
one \`DEFAULT CURRENT_TIMESTAMP\` on its own, and whether it does depends on
\`explicit_defaults_for_timestamp\` — a server setting, which is not in these files. Reporting it would
be a claim about somebody's configuration rather than about their SQL.`,

  check(ctx) {
    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target?.list) continue;

      // Folded the way a qualifier is, and read off the tokens rather than the names the list
      // carries, because folding needs to know whether each name was written delimited.
      const given = new Set<string>();
      let unknown = false;
      for (let i = target.list.from; i <= target.list.to; i++) {
        const t = ctx.tokens[i]!;
        if (t.t !== "id") continue;
        const folded = ctx.dialect.foldIdentifier(t.v, t.q ?? false);
        given.add(folded);
        if (!target.table.byName.has(folded)) unknown = true;
      }

      // An empty parenthesis names nothing, so nothing can be said to be missing from it: the
      // insert is positional and its values come from somewhere else entirely.
      if (given.size === 0) continue;

      // A list holding a name the table does not have is a list describing some other shape, and
      // which of its names were meant to be which is not a question this rule can answer.
      // `query/insert-unknown-column` reports that statement already; saying it is also missing
      // things would be a second message about one defect.
      if (unknown) continue;

      const missing = target.table.columns
        .filter((c) => {
          if (c.nullable || c.autoIncrement || c.generated || c.default !== undefined) return false;
          // See the note about `explicit_defaults_for_timestamp` above.
          if (c.type.name === "timestamp") return false;
          return !given.has(ctx.dialect.foldIdentifier(c.name, c.quoted));
        })
        .map((c) => c.name);

      if (missing.length === 0) continue;
      ctx.report(
        ctx.tokens[target.list.from]!,
        `${target.table.name} needs a value for ${missing.join(", ")}`,
      );
    }
  },
};
