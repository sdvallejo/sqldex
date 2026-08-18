import type { Rule } from "../rule.ts";
import { insertTarget } from "./insert-target.ts";

export const insertUnknownColumn: Rule = {
  id: "query/insert-unknown-column",
  group: "query",
  // The same token is a column that does not exist to `names/unqualified-column`, which cannot say
  // which table it is missing from. This can, so it is the one worth hearing.
  supersedes: ["names/unqualified-column"],
  severity: "error",
  scope: "statement",
  docs: `A column named in an \`INSERT\`'s list that the table does not have.

Full certainty, so an error: the engine rejects the statement. It comes for free once the column list
has been read in order to count it, and it catches the half of a rename that updated the table and
not its inserts.

The parenthesis after the table name is only read as a column list when it is one. \`INSERT INTO t
(SELECT …)\` wraps the query feeding the insert, and read as a column list every word of that subquery
comes out as a column the table does not have.`,

  check(ctx) {
    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target?.list) continue;

      for (let i = target.list.from; i <= target.list.to; i++) {
        const t = ctx.tokens[i]!;
        if (t.t !== "id") continue;
        if (target.table.byName.has(ctx.dialect.foldIdentifier(t.v, t.q ?? false))) continue;
        ctx.report(t, `${target.table.name} has no column ${t.v}`);
      }
    }
  },
};
