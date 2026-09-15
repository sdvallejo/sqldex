import { firstRowOnly, writtenValues } from "../shared/written.ts";
import { literalOf } from "../shared/literals.ts";
import type { Rule } from "../rule.ts";

export const writeNullToNotNull: Rule = {
  id: "query/write-null-to-not-null",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `\`NULL\` written into a column declared \`NOT NULL\`.

Strict mode refuses the write outright: error 1048, *Column 'c' cannot be null* — in an \`INSERT\` of
one row, in any row of a multi-row one, and in an \`UPDATE\`'s \`SET\`. \`STRICT_TRANS_TABLES\` is in the
default \`sql_mode\` of both MySQL and MariaDB, so the statement fails on a server left at its
defaults.

**\`AUTO_INCREMENT\` is the one column an \`INSERT\`'s own \`NULL\` never reaches**, because it is also
the spelling that asks the server to generate the next value — \`INSERT INTO t (id, …) VALUES (NULL,
…)\` is the ordinary way of leaving it to the counter, not a defect. An \`UPDATE\` is a different
statement with no such meaning: \`UPDATE t SET id = NULL\` is refused exactly like any other
\`NOT NULL\` column, and \`ON DUPLICATE KEY UPDATE id = NULL\` is read the same way, since it only ever
fires on a row that already has an id.

**A \`TIMESTAMP\` is left alone**, the same criterion \`query/insert-missing-required-column\` uses for
the same column. MySQL refuses \`NULL\` into a \`NOT NULL\` one, but MariaDB accepts it, in an \`INSERT\`
and in an \`UPDATE\` alike, and nothing in these files says which of the two a project runs.

A generated column is a different rule's finding: \`query/write-to-generated-column\` reports any
value at all given to one, \`NULL\` included, with its own error.

What it deliberately leaves alone:

  - **\`INSERT IGNORE\`/\`UPDATE IGNORE\`**, which downgrade the refusal to a warning.
  - **A table the catalog does not hold, or a nullable column.**
  - **Anything but the literal \`NULL\`** — an expression that may evaluate to it is not this rule's
    business, since the statement itself does not say so.
  - **A non-transactional table's second row onward.** On MyISAM, MEMORY, ARCHIVE and CSV,
    \`STRICT_TRANS_TABLES\` refuses a \`NULL\` in the first row of a multi-row \`INSERT\` and only warns
    about one in a later row.

A project whose server does not run this mode silences the rule in \`.sqldex.json\`.`,

  check(ctx) {
    for (const value of writtenValues(ctx)) {
      if (value.column.nullable || value.column.generated) continue;
      if (value.ignore) continue;
      if (value.row > 1 && firstRowOnly(value.table)) continue;
      if (value.column.type.name === "timestamp") continue;
      if (value.form === "insert" && value.column.autoIncrement) continue;

      const literal = literalOf(ctx.tokens, value.value);
      if (literal?.kind !== "null") continue;

      ctx.report(
        ctx.tokens[value.value.from]!,
        `${value.column.name} is NOT NULL and this write gives it NULL: the default (strict) sql_mode refuses it`,
      );
    }
  },
};
