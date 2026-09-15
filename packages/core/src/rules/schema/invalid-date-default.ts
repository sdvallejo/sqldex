import { hasZeroField, isImpossibleDate, parseDateShape } from "../shared/dates.ts";
import { unquote } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

const DATE_TYPES: ReadonlySet<string> = new Set(["date", "datetime", "timestamp"]);

/** Is `raw` a bare integer literal, the shape `DEFAULT 0` takes? */
function bareZero(raw: string): boolean {
  return /^-?\d+$/.test(raw) && Number(raw) === 0;
}

export const invalidDateDefault: Rule = {
  id: "schema/invalid-date-default",
  group: "schema",
  severity: "warn",
  scope: "table",
  docs: `A \`DATE\`/\`DATETIME\`/\`TIMESTAMP\` column defaulting to a value the calendar does not have.

MySQL refuses to create the table at all: error 1067, *Invalid default value for 'c'*. Not a warning
on the row that eventually hits it — the \`CREATE TABLE\` itself never runs, so every migration after
it is blocked on a statement that was wrong before anything was ever inserted.

**A zero date, or a zero month or day, is refused by MySQL alone.**
\`NO_ZERO_IN_DATE\`/\`NO_ZERO_DATE\` are in its default \`sql_mode\` and not in MariaDB's, so
\`DEFAULT '0000-00-00'\`, \`DEFAULT '2020-00-15'\` and \`DEFAULT 0\` all create cleanly on MariaDB —
which is how they end up in a dump taken from one, or in DDL nobody has tried against MySQL yet. The
table then fails to create the first time that same file reaches a MySQL server left at its defaults,
far from whoever wrote the \`DEFAULT\`: the same argument \`query/write-target-in-subquery\` makes for
its own MySQL-only error. **A year alone at zero is not this** — \`DEFAULT '0000-05-15'\` is accepted
by both engines.

**An impossible date — \`DEFAULT '2020-02-30'\`, a February the 30th no year has — is refused by both
engines at their defaults.**

**Only \`YYYY-MM-DD[ HH:MM:SS[.f]]\`, MySQL's own canonical spelling, is read.** A \`DEFAULT\` written
any other way, or as an expression such as \`CURRENT_TIMESTAMP\`, is left alone rather than guessed
at — reading every format the server's parser happens to tolerate is a different project from this
one, and a \`DEFAULT\` this rule cannot read is not one it can call wrong.

A project whose server does not run \`NO_ZERO_IN_DATE\`/\`NO_ZERO_DATE\`, or runs MariaDB, silences the
zero-date half of this by turning the whole rule off in \`.sqldex.json\` — sqldex has no \`sql_mode\`
setting or dialect to read either fact from, and there is no way to keep only the impossible-date
half on.`,

  check(ctx) {
    for (const column of ctx.table.columns) {
      if (!DATE_TYPES.has(column.type.name) || column.default === undefined) continue;
      const raw = column.default;

      if (bareZero(raw)) {
        ctx.report(
          column.nameSpan,
          `${column.name} defaults to 0, a date MySQL refuses to create the table with (MariaDB accepts it)`,
        );
        continue;
      }

      if (raw.length < 2 || (raw[0] !== "'" && raw[0] !== '"')) continue;
      const text = unquote(raw);
      const date = parseDateShape(text);
      if (!date) continue;

      if (hasZeroField(date)) {
        ctx.report(
          column.nameSpan,
          `${column.name} defaults to '${text}', a zero month or day MySQL refuses to create the table with (MariaDB accepts it)`,
        );
      } else if (isImpossibleDate(date)) {
        ctx.report(
          column.nameSpan,
          `${column.name} defaults to '${text}', which is not a real date: MySQL and MariaDB both refuse this table`,
        );
      }
    }
  },
};
