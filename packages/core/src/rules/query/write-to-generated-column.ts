import { insertTarget } from "../shared/inserts.ts";
import { isDefaultKeyword, writtenValues } from "../shared/written.ts";
import { kw, splitCommas } from "../../syntax/fast/tok.ts";
import type { Column } from "../../model/table.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

export const writeToGeneratedColumn: Rule = {
  id: "query/write-to-generated-column",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `A write that gives a value to a generated column.

A generated column is computed from the others, and MySQL will not let a statement set it: error
3105, *the value specified for generated column 'c' in table 't' is not allowed*. Not a warning and
not a silent overwrite — the whole statement fails at execution time, so an \`INSERT\` in a branch
that runs once a month fails once a month.

It is what turns up after a column is made generated. The expression moves into the DDL, every
\`INSERT\` that used to compute the value by hand keeps computing it, and each one now names a column
it is no longer allowed to name.

**The one accepted value is the word \`DEFAULT\`**, which tells the server to compute the column
rather than hand it anything, and every form that takes it is checked against a live server rather
than assumed: \`INSERT … VALUES (1, DEFAULT)\`, \`UPDATE … SET c = DEFAULT\` and
\`ON DUPLICATE KEY UPDATE c = DEFAULT\` are all accepted, and any other value in any of those places
is refused. In a multi-row \`VALUES\` it is per row: one row with a real value is enough to fail the
statement, which is why every row is read rather than the first.

An \`INSERT … SELECT\` naming a generated column is always reported: \`DEFAULT\` is not something a
select list can produce, so there is no spelling of that statement the server accepts.

What it leaves alone: a **positional** \`INSERT\` with no column list, where nothing is named and the
count is \`query/insert-select-column-count\`'s question; and a table the catalog does not hold, where
there is no way to know which columns are generated.`,

  check(ctx) {
    const { tokens } = ctx;
    const report = (at: Token, column: Column): void => {
      ctx.report(at, `${column.name} is a generated column: MySQL refuses a write that gives it a value`);
    };

    // Every write this statement makes, grouped by the token that names the column: one row of a
    // multi-row `VALUES` with a real value is enough to fail the whole statement, so a generated
    // column reported at all is reported once, at the name the write gave it.
    const byName = new Map<Token, { column: Column; given: boolean }>();
    for (const value of writtenValues(ctx)) {
      if (!value.column.generated) continue;
      const entry = byName.get(value.nameToken) ?? { column: value.column, given: false };
      if (!isDefaultKeyword(tokens, value.value)) entry.given = true;
      byName.set(value.nameToken, entry);
    }
    for (const [nameToken, entry] of byName) {
      if (entry.given) report(nameToken, entry.column);
    }

    // `INSERT … SELECT` naming a generated column: a select list cannot say `DEFAULT`, so this is
    // always reported. `writtenValues` produces nothing for this shape — there are no rows to read,
    // only a query — so it is read here instead.
    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target?.list) continue;
      if (kw(tokens[target.after], "VALUES") || kw(tokens[target.after], "VALUE")) continue;

      for (const item of splitCommas(tokens, target.list.from + 1, target.list.to - 1)) {
        const nameToken = tokens[item.from];
        if (nameToken?.t !== "id") continue;
        const column = target.table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q === true));
        if (column?.generated) report(nameToken, column);
      }
    }
  },
};
