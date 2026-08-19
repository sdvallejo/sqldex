import { insertTarget } from "../shared/inserts.ts";
import { selectList, selectWidth } from "../shared/selects.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const insertSelectColumnCount: Rule = {
  id: "query/insert-select-column-count",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `An \`INSERT … SELECT\` whose select list does not fill the table it writes to.

\`query/insert-value-count\` checks the \`VALUES\` form of the same mistake. This is the other one, and
in a schema dumped out of a live database it is the commoner of the two: the audit convention is
written as \`INSERT INTO aud_t SELECT 0, NOW(), pUser, …, t.* FROM t\`, a positional list of twenty
columns, and every column added to \`t\` afterwards has to be added to \`aud_t\` **and** stay in step
with the eight scalars in front of the star. MySQL rejects the mismatch at execution time, so it is an
error — but only when that branch runs, which for an audit insert in an error path may be months.

**A \`*\` is counted rather than skipped**, and that is what makes the rule mean anything here: \`t.*\`
is one token to a lexer and however many columns \`t\` has to MySQL. Without the catalog there is no
count to make, which is why no dialect-blind linter can check the shape these repositories are full
of. The relations a star expands against are the **query's**, not the statement's: the statement's
include the table being written, and counting its columns into the source's width would be comparing
the target with itself.

With an explicit column list the count is against that list; without one, against the table — and
where the table has generated columns both the full count and the stored-only count are accepted,
since a positional insert may pass a generated column \`DEFAULT\` or leave it out.

What it deliberately leaves alone:

  - **A star over anything the catalog does not hold** — a temporary table, a derived table, a
    database this repo does not define. Where the width is unknown there is no claim, and this rule
    reports errors: it does not get to guess.
  - **A \`UNION\`**, whose branches each have their own list, and which MySQL has already compared
    with each other before this count matters.
  - **A table the catalog does not have**, which is \`names/unknown-table\`'s finding, not this one's.`,

  check(ctx) {
    const { tokens } = ctx;
    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target) continue;

      // `INSERT INTO t (SELECT …)` wraps the query in a parenthesis, which is legal and means the
      // same thing; `insertTarget` has already declined to read that as a column list.
      let at = target.after;
      if (punct(tokens[at], "(")) at++;
      if (!kw(tokens[at], "SELECT")) continue;

      let union = false;
      for (let i = at; i <= ctx.statement.to; i++) {
        if (kw(tokens[i], "UNION")) union = true;
      }
      if (union) continue;

      const list = selectList(tokens, at, ctx.statement.to);
      if (!list) continue;

      const width = selectWidth(ctx, list, at, ctx.statement.to);
      if (width === undefined) continue;

      // `expected` is what the reader is told; `accepted` is what it is compared against, which may
      // be more than one number.
      let expected: number;
      const accepted = new Set<number>();
      if (target.list) {
        expected = target.list.names.length;
        accepted.add(expected);
      } else {
        expected = target.table.columns.length;
        accepted.add(expected);
        accepted.add(target.table.columns.filter((c) => !c.generated).length);
      }

      if (accepted.has(width)) continue;

      // `INSERT INTO t () SELECT …` is a column list of nothing, which MySQL reads as "all defaults"
      // and then rejects for being handed values. Saying "expects 0" would leave the reader counting
      // the table's columns to find out why; the empty parentheses are the whole of it.
      ctx.report(
        tokens[at]!,
        target.list && expected === 0
          ? `${target.table.name} () is an empty column list, and this SELECT hands it ${width} column(s)`
          : `this SELECT gives ${target.table.name} ${width} column(s) and it expects ${expected}`,
      );
    }
  },
};
