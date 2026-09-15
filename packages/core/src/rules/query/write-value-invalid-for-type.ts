import { firstRowOnly, writtenValues } from "../shared/written.ts";
import { hasZeroField, isImpossibleDate, isImpossibleTime, parseDateShape } from "../shared/dates.ts";
import { literalOf, NUMERIC, type Literal } from "../shared/literals.ts";
import { unquote } from "../../syntax/fast/tok.ts";
import type { Column } from "../../model/table.ts";
import type { Rule } from "../rule.ts";

const DATE_TYPES: ReadonlySet<string> = new Set(["date", "datetime", "timestamp"]);

/**
 * Does `text` read as *some* number — integer, decimal or scientific notation, signed either way —
 * the way MySQL converts a string before storing it in a numeric column?
 *
 * Stricter than `Number(text)`: a hex string like `'0x10'` does not count, because MySQL reads it as
 * the text `"0x10"`, not as the number 16, and `Number` alone would call that a number by mistake.
 */
const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i;
function looksNumeric(text: string): boolean {
  return NUMERIC_LITERAL.test(text.trim());
}

function numericStringProblem(column: Column, literal: Literal): string | undefined {
  if (literal.kind !== "str" || !NUMERIC.has(column.type.name)) return undefined;
  if (looksNumeric(literal.text)) return undefined;
  return `${column.name} is ${column.type.raw} and '${literal.text}' does not read as a number`;
}

function dateProblem(column: Column, literal: Literal): string | undefined {
  if (!DATE_TYPES.has(column.type.name)) return undefined;
  const head = `${column.name} is ${column.type.raw} and`;

  if (literal.kind === "num") {
    return Number(literal.text) === 0 ? `${head} 0 is a zero date, which MariaDB alone accepts` : undefined;
  }
  if (literal.kind !== "str") return undefined;

  const date = parseDateShape(literal.text);
  if (!date) return undefined;

  if (hasZeroField(date)) return `${head} '${literal.text}' is a zero date, which MariaDB alone accepts`;
  if (isImpossibleDate(date)) return `${head} '${literal.text}' is not a real date`;
  // A `DATE` column drops whatever time of day a write carries, with only a note — checking it
  // would report a value MySQL itself accepts.
  if (column.type.name !== "date" && isImpossibleTime(date)) return `${head} '${literal.text}' has an impossible time of day`;
  return undefined;
}

function normalized(value: string): string {
  return value.replace(/ +$/, "").toLowerCase();
}

/** Does `value` match one of `declared`, the way this column compares them — exact under a `_bin`
 * collation, case-insensitive and trailing-space-blind otherwise? */
function declaredMatch(value: string, declared: readonly string[], exact: boolean): boolean {
  return declared.some((d) => (exact ? d === value : normalized(d) === normalized(value)));
}

function enumSetProblem(column: Column, literal: Literal): string | undefined {
  const type = column.type.name;
  if (type !== "enum" && type !== "set") return undefined;
  const declared = column.type.args.map(unquote);
  const head = `${column.name} is ${column.type.raw} and`;

  if (literal.kind === "num") {
    // A SET's numeric form is a bitmask, a different question this rule does not read.
    if (type !== "enum") return undefined;
    const index = Number(literal.text);
    if (!Number.isInteger(index) || (index >= 1 && index <= declared.length)) return undefined;
    return `${head} index ${index} is out of range`;
  }
  if (literal.kind !== "str") return undefined;

  const exact = column.collation?.toLowerCase().endsWith("_bin") === true;
  if (type === "set") {
    if (literal.text === "") return undefined; // the empty SET, holding none of its members
    const missing = literal.text.split(",").filter((item) => !declaredMatch(item, declared, exact));
    return missing.length === 0 ? undefined : `${head} does not declare ${missing.join(", ")}`;
  }
  return declaredMatch(literal.text, declared, exact) ? undefined : `${head} does not declare '${literal.text}'`;
}

export const writeValueInvalidForType: Rule = {
  id: "query/write-value-invalid-for-type",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A literal written into a column that cannot hold what it says.

Strict mode refuses these outright: a string with no numeric reading into a numeric column is error
1366 or 1265 depending on how it fails, a date the calendar does not have is error 1292, and a
string outside an \`ENUM\`/\`SET\`'s declared members is error 1265. \`STRICT_TRANS_TABLES\` is in the
default \`sql_mode\` of both MySQL and MariaDB, so the statement fails on a server left at its
defaults — and passes on one whose \`sql_mode\` was relaxed, which is where a statement like this gets
written and tried.

**A numeric column takes a string that reads as a number and refuses one that does not**, after
trimming its spaces — \`'1.5'\` and \`'1e3'\` are read as numbers and pass through; \`''\`, \`'abc'\` and
\`'12abc'\` are not, whatever error number each one earns. A hex-looking string like \`'0x10'\` is not a
number either: MySQL stores its text, not the value the digits would spell in another base.

**A date is judged only in \`YYYY-M-D[ H:M:S[.f]]\`**, MySQL's own canonical spelling with each field
one or two digits. Any other shape — \`'20200515'\`, \`'2020/05/15'\`, free text — is left alone rather
than guessed at, because reading every format the server's parser happens to tolerate is a different
project from this one. Within that shape, a month over 12 or a day past the end of its month is
refused by both engines, and so is an impossible hour, minute or second in a \`DATETIME\`/\`TIMESTAMP\`
— \`:60\` included. **A zero month or a zero day is refused by MySQL alone**:
\`NO_ZERO_IN_DATE\`/\`NO_ZERO_DATE\` are in its default \`sql_mode\` and not in MariaDB's, so
\`'0000-00-00'\` and \`'2020-00-15'\` both load on MariaDB and fail the first time the same statement
reaches a MySQL server left at its defaults — the same argument \`query/write-target-in-subquery\`
makes for its own MySQL-only error. **The bare literal \`0\` is a zero date too**, in all three types.
A \`DATE\` column drops whatever time of day a write carries, with only a note, so an impossible one
is not checked there.

**An \`ENUM\`/\`SET\` value is compared case-insensitively, with its trailing spaces trimmed** —
\`'A '\` matches \`'A'\`, and \`' A'\` does not, since only a trailing space is what the server trims. A
column with a \`_bin\` collation compares exactly instead, case included: an \`ENUM('A')\` under one
refuses the lower-case \`'a'\` that an ordinary collation would accept. An \`ENUM\`'s numeric form is its
1-based index into the declared list, and one outside \`1..n\` is refused the same way; a \`SET\`'s
numeric form is a bitmask, a different question this rule does not read.

What it deliberately leaves alone:

  - **\`INSERT IGNORE\`/\`UPDATE IGNORE\`**, which downgrade every one of these to a warning.
  - **A table the catalog does not hold**, or a value that is not a literal at all.
  - **A generated column.** \`query/write-to-generated-column\` already refuses the write outright,
    whatever the value; saying the value would also have been invalid is not a second defect.
  - **A non-transactional table's second row onward.** On MyISAM, MEMORY, ARCHIVE and CSV,
    \`STRICT_TRANS_TABLES\` refuses a bad value in the first row of a multi-row \`INSERT\` and only warns
    about one in a later row.

A project whose server does not run this mode, or runs MariaDB, silences the rule in
\`.sqldex.json\` — sqldex has no \`sql_mode\` setting or dialect to read, because a rule never sees a
project's config and this engine has only the one dialect.`,

  check(ctx) {
    for (const value of writtenValues(ctx)) {
      if (value.ignore || value.column.generated) continue;
      if (value.row > 1 && firstRowOnly(value.table)) continue;

      const literal = literalOf(ctx.tokens, value.value);
      if (!literal) continue;

      const detail =
        numericStringProblem(value.column, literal) ??
        dateProblem(value.column, literal) ??
        enumSetProblem(value.column, literal);
      if (!detail) continue;

      ctx.report(ctx.tokens[value.value.from]!, `${detail}: the default (strict) sql_mode refuses it`);
    }
  },
};
