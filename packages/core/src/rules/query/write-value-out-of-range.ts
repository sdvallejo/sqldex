import { firstRowOnly, writtenValues } from "../shared/written.ts";
import { literalOf, type Literal } from "../shared/literals.ts";
import type { Column } from "../../model/table.ts";
import type { Rule } from "../rule.ts";

interface IntRange {
  min: bigint;
  max: bigint;
  unsignedMax: bigint;
}

/** Ranges MySQL documents for its fixed-width integer types, folded to lower case. */
const INT_RANGES: ReadonlyMap<string, IntRange> = new Map([
  ["tinyint", { min: -128n, max: 127n, unsignedMax: 255n }],
  ["smallint", { min: -32768n, max: 32767n, unsignedMax: 65535n }],
  ["mediumint", { min: -8388608n, max: 8388607n, unsignedMax: 16777215n }],
  ["int", { min: -2147483648n, max: 2147483647n, unsignedMax: 4294967295n }],
  ["integer", { min: -2147483648n, max: 2147483647n, unsignedMax: 4294967295n }],
  ["bigint", { min: -9223372036854775808n, max: 9223372036854775807n, unsignedMax: 18446744073709551615n }],
]);

const DECIMAL_TYPES: ReadonlySet<string> = new Set(["decimal", "dec", "numeric", "fixed"]);

interface Numeral {
  negative: boolean;
  intDigits: string;
  fracDigits: string;
}

/** A plain decimal numeral: an optional sign, digits, an optional `.` and more digits. */
const NUMERAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Reads a literal as a numeral, the way a numeric column would — a numeric string counts too. */
function numeralOf(literal: Literal): Numeral | undefined {
  if (literal.kind === "null") return undefined;
  const text = literal.kind === "str" ? literal.text.trim() : literal.text;
  const m = NUMERAL.exec(text);
  return m ? { negative: m[1] !== undefined, intDigits: m[2]!, fracDigits: m[3] ?? "" } : undefined;
}

/**
 * The numeral's magnitude, rounded to `scale` fractional digits half away from zero — the same
 * rounding MySQL itself applies to a literal that carries more precision than the column does.
 */
function roundedMagnitude(numeral: Numeral, scale: number): bigint {
  let value = BigInt(numeral.intDigits);
  const frac = numeral.fracDigits;
  if (frac.length > scale && frac.charCodeAt(scale) >= "5".charCodeAt(0)) value += 1n;
  return value;
}

function rangeProblem(column: Column, numeral: Numeral): string | undefined {
  const type = column.type.name;
  const unsigned = column.type.unsigned === true;

  const range = INT_RANGES.get(type);
  if (range) {
    if (unsigned && numeral.negative) return "holds no negative values";
    const magnitude = roundedMagnitude(numeral, 0);
    const value = numeral.negative ? -magnitude : magnitude;
    const min = unsigned ? 0n : range.min;
    const max = unsigned ? range.unsignedMax : range.max;
    return value < min || value > max ? `holds ${min} to ${max}` : undefined;
  }

  if (DECIMAL_TYPES.has(type)) {
    if (unsigned && numeral.negative) return "holds no negative values";
    const precision = column.type.args[0] !== undefined ? Number(column.type.args[0]) : 10;
    const scale = column.type.args[1] !== undefined ? Number(column.type.args[1]) : 0;
    const magnitude = roundedMagnitude(numeral, scale);
    const digits = magnitude === 0n ? 1 : magnitude.toString().length;
    const allowed = precision - scale;
    return digits > allowed ? `holds at most ${allowed} integer digit(s)` : undefined;
  }

  return undefined;
}

export const writeValueOutOfRange: Rule = {
  id: "query/write-value-out-of-range",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A literal written into an integer or \`DECIMAL\` column too narrow to hold it.

Strict mode refuses the write outright: error 1264, *Out of range value for column 'c'*.
\`STRICT_TRANS_TABLES\` is in the default \`sql_mode\` of both MySQL and MariaDB, so the statement fails
on a server left at its defaults — and passes on one whose \`sql_mode\` was relaxed, which is where a
statement like this gets written and tried.

**The value is rounded before it is judged**, the way the server rounds a literal that carries more
precision than the column does — to an integer for \`TINYINT\`…\`BIGINT\` and to the declared scale for
\`DECIMAL(p,s)\`. \`127.4\` into a \`TINYINT\` rounds down and fits; \`127.5\` rounds
up and does not. A \`DECIMAL(5,2)\` has three integer digits to spend once its two decimal places are
taken, so \`999.995\` rounds to \`1000.00\` and is out of range, while the extra precision of \`1.239\`
rounds away without ever reaching those three digits. **Any negative literal into an \`UNSIGNED\`
column is refused, whatever it rounds to** — even \`-0.4\`. A numeric string is read the same as a
bare number: \`'300'\` into a \`TINYINT\` is refused like \`300\`.

\`FLOAT\`, \`DOUBLE\`, \`BIT\` and \`YEAR\` are not read.

What it deliberately leaves alone:

  - **\`INSERT IGNORE\`/\`UPDATE IGNORE\`**, which downgrade the refusal to a warning.
  - **A table the catalog does not hold**, where there is no declared range to compare against.
  - **Anything but a literal.**
  - **A generated column.** \`query/write-to-generated-column\` already refuses the write outright,
    whatever the value; saying the value would also have been out of range is not a second defect.
  - **A non-transactional table's second row onward.** On MyISAM, MEMORY, ARCHIVE and CSV,
    \`STRICT_TRANS_TABLES\` refuses a bad value in the first row of a multi-row \`INSERT\` and only warns
    about one in a later row.

A project whose server does not run this mode silences the rule in \`.sqldex.json\`.`,

  check(ctx) {
    for (const value of writtenValues(ctx)) {
      if (value.ignore || value.column.generated) continue;
      if (value.row > 1 && firstRowOnly(value.table)) continue;

      const literal = literalOf(ctx.tokens, value.value);
      if (!literal) continue;
      const numeral = numeralOf(literal);
      if (!numeral) continue;

      const problem = rangeProblem(value.column, numeral);
      if (!problem) continue;
      ctx.report(
        ctx.tokens[value.value.from]!,
        `${value.column.name} is ${value.column.type.raw}, which ${problem}: the default (strict) sql_mode refuses this value`,
      );
    }
  },
};
