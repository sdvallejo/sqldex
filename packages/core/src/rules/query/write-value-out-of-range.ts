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

/**
 * How MySQL read the literal, which decides both its rounding rule and its `UNSIGNED` refusal: a
 * plain decimal rounds half away from zero and refuses any negative magnitude; an exponent literal
 * with no quotes is a `DOUBLE` and rounds half to even; a numeric string rounds half away from zero
 * whatever shape it carries, exponent included, but — unlike a plain decimal — is only refused
 * `UNSIGNED` when its rounded value is negative.
 */
type NumeralKind = "exact" | "approximate" | "string";

interface Numeral {
  negative: boolean;
  intDigits: string;
  fracDigits: string;
  kind: NumeralKind;
}

/**
 * A plain decimal numeral, with an optional sign, digits, an optional `.` and more digits, and an
 * optional exponent — `1e9`, `2.5e-2`, `-1.3E+4` all match.
 */
const NUMERAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * An exponent past this magnitude is not one any real column's precision could ever reach either
 * way — standing down here keeps the digit shifting below from building an absurdly long string.
 */
const MAX_EXPONENT = 400;

/** A numeral's significant digits: its digit string with leading zeros stripped. */
function significantDigits(intDigits: string, fracDigits: string): number {
  const stripped = (intDigits + fracDigits).replace(/^0+/, "");
  return stripped.length || 1;
}

/**
 * Moves a numeral's decimal point by `exponent` places, exactly — string digit shifting, not
 * floating point, so `1.265e2` becomes intDigits `126`, fracDigits `5` rather than a value a
 * `DOUBLE` merely rounds to.
 */
function shiftExponent(intDigits: string, fracDigits: string, exponent: number): { intDigits: string; fracDigits: string } {
  const digits = intDigits + fracDigits;
  const point = intDigits.length + exponent;
  if (point <= 0) return { intDigits: "0", fracDigits: "0".repeat(-point) + digits };
  if (point >= digits.length) return { intDigits: digits + "0".repeat(point - digits.length), fracDigits: "" };
  return { intDigits: digits.slice(0, point), fracDigits: digits.slice(point) };
}

/** Reads a literal as a numeral, the way a numeric column would — a numeric string counts too. */
function numeralOf(literal: Literal): Numeral | undefined {
  if (literal.kind === "null") return undefined;
  const text = literal.kind === "str" ? literal.text.trim() : literal.text;
  const m = NUMERAL.exec(text);
  if (!m) return undefined;
  const negative = m[1] !== undefined;
  const intDigits = m[2]!;
  const fracDigits = m[3] ?? "";
  const exponentText = m[4];

  if (exponentText === undefined) {
    return { negative, intDigits, fracDigits, kind: literal.kind === "str" ? "string" : "exact" };
  }

  const exponent = Number(exponentText);
  if (Math.abs(exponent) > MAX_EXPONENT) return undefined;

  // A DOUBLE cannot hold more than about fifteen significant digits, so past that the exact decimal
  // this literal spells out is not the value the server actually rounds to — only a bare exponent
  // literal is read as a DOUBLE; a quoted one is read digit for digit regardless of its length.
  if (literal.kind === "num" && significantDigits(intDigits, fracDigits) > 15) return undefined;

  const shifted = shiftExponent(intDigits, fracDigits, exponent);
  return { negative, ...shifted, kind: literal.kind === "str" ? "string" : "approximate" };
}

/**
 * The numeral's magnitude, rounded to `scale` fractional digits half away from zero — the same
 * rounding MySQL itself applies to a plain decimal or a numeric string that carries more precision
 * than the column does.
 */
function roundedMagnitude(numeral: Numeral, scale: number): bigint {
  let value = BigInt(numeral.intDigits);
  const frac = numeral.fracDigits;
  if (frac.length > scale && frac.charCodeAt(scale) >= "5".charCodeAt(0)) value += 1n;
  return value;
}

/**
 * The numeral's magnitude, rounded to `scale` fractional digits half to even — the rounding a
 * `DOUBLE`-typed literal (one written with an exponent and no quotes) gets when it is stored into an
 * integer column, unlike the half-away-from-zero rounding a plain decimal or a numeric string gets.
 */
function roundedMagnitudeHalfToEven(numeral: Numeral, scale: number): bigint {
  let value = BigInt(numeral.intDigits);
  const remainder = numeral.fracDigits.slice(scale);
  if (remainder.length === 0) return value;
  const five = "5".charCodeAt(0);
  const first = remainder.charCodeAt(0);
  if (first > five || (first === five && /[1-9]/.test(remainder.slice(1)))) {
    value += 1n;
  } else if (first === five && value % 2n === 1n) {
    value += 1n;
  }
  return value;
}

/** Is the numeral's magnitude exactly zero — `-0` and `-0.0`, which MySQL does not treat as negative? */
function isZeroMagnitude(numeral: Numeral): boolean {
  return /^0*$/.test(numeral.intDigits) && /^0*$/.test(numeral.fracDigits);
}

function rangeProblem(column: Column, numeral: Numeral): string | undefined {
  const type = column.type.name;
  const unsigned = column.type.unsigned === true;

  const range = INT_RANGES.get(type);
  if (range) {
    // A plain decimal is refused whatever it rounds to, except a literal magnitude of zero. A
    // numeric string or an exponent literal is judged on its rounded value instead — the range
    // check below already refuses one that rounds below zero.
    if (unsigned && numeral.negative && numeral.kind === "exact" && !isZeroMagnitude(numeral)) {
      return "holds no negative values";
    }
    const magnitude =
      numeral.kind === "approximate" ? roundedMagnitudeHalfToEven(numeral, 0) : roundedMagnitude(numeral, 0);
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
rounds away without ever reaching those three digits — \`1E+2\` written the same way is read as
\`100.00\` and fits.

A bare literal written with an exponent (\`1.265e2\`) is read as a \`DOUBLE\`, not a plain decimal, and
a \`DOUBLE\` rounds into an integer column **half to even** rather than half away from zero:
\`1.265e2\` stores \`126\`, but \`1.275e2\` stores \`128\`. A quoted numeric string still rounds half
away from zero whatever shape it carries, exponent included: the bare \`-1.285e2\` rounds to \`-128\`
and fits a \`TINYINT\`, while the quoted \`'-1.285e2'\` rounds to \`-129\` and is refused.

**A plain decimal literal into an \`UNSIGNED\` column is refused whenever it is negative, whatever it
rounds to** — even \`-0.4\` — though \`-0\` and \`-0.0\` are not refused, since a magnitude of zero is
not negative. A numeric string or an exponent literal into an \`UNSIGNED\` integer column is judged
more leniently: it is refused only when its *rounded* value is negative, so \`'-0.4'\` and \`-4e-1\`
both round to \`0\` and are accepted while \`'-0.5'\` and \`-1.5e0\` round to a negative integer and
are refused. \`UNSIGNED DECIMAL\` keeps the stricter rule regardless of how the literal is written:
any negative value is refused.

\`FLOAT\`, \`DOUBLE\`, \`BIT\` and \`YEAR\` are not read.

What it deliberately leaves alone:

  - **\`INSERT IGNORE\`/\`UPDATE IGNORE\`**, which downgrade the refusal to a warning.
  - **A table the catalog does not hold**, where there is no declared range to compare against.
  - **Anything but a literal.**
  - **An exponent literal with more than fifteen significant digits.** A \`DOUBLE\` cannot hold that
    much precision, so the decimal value the server actually rounds to is no longer the one written —
    guessing at it would be wrong as often as right.
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
