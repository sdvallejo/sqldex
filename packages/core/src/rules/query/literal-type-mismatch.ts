import { columnAt, setClause } from "../shared/columns.ts";
import type { Column } from "../../model/table.ts";
import { kw, matchingParen, punct, unquote } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Comparisons where a converted operand costs an index and can change the answer. */
const COMPARISONS: ReadonlySet<string> = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "<=>"]);

const NUMERIC: ReadonlySet<string> = new Set([
  "int",
  "integer",
  "bigint",
  "smallint",
  "tinyint",
  "mediumint",
  "decimal",
  "dec",
  "numeric",
  "fixed",
  "float",
  "double",
  "real",
  "bit",
]);

const TEXT: ReadonlySet<string> = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"]);

/** Is this string a number as MySQL would read one, so that comparing it costs nothing? */
function readsAsNumber(literal: string): boolean {
  const text = unquote(literal).trim();
  return text.length > 0 && Number.isFinite(Number(text));
}

/** The two shapes worth reporting, or `undefined` when the pair is fine. */
function mismatch(column: Column, literal: Token): string | undefined {
  const type = column.type.name.toLowerCase();

  if (TEXT.has(type) && literal.t === "num") {
    return (
      "MySQL converts the column to a number to compare it, which rules out the index on it — and " +
      "makes '007' equal to 7"
    );
  }
  if (NUMERIC.has(type) && literal.t === "str" && !readsAsNumber(literal.v)) {
    return "MySQL reads the string as a number, which is 0 here, so the comparison is not the one written";
  }
  return undefined;
}

export const literalTypeMismatch: Rule = {
  id: "query/literal-type-mismatch",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A column compared against a literal of another type.

MySQL does not refuse this. It converts one side and carries on, and **which side it converts is the
whole problem**: comparing a text column with a number converts *the column*, once per row. The index
on it cannot be used, and the comparison stops being the one that was written — \`'007'\`, \`'7 '\` and
\`'7abc'\` all equal \`7\` once both sides are numbers.

The other direction is quieter still. A number compared against a string that is not a number reads
the string as \`0\`, so \`WHERE id = 'A'\` is \`WHERE id = 0\`: not an error, not a match, just a query
that finds nothing for a reason nothing on the line explains.

**Only the catalog knows which side is which.** \`WHERE code = 100\` is fine against an \`int\` and a
scan against a \`varchar\`, and the difference is in a \`CREATE TABLE\` somewhere else in the repository.

What it deliberately leaves alone:

  - **A numeric string against a numeric column**, \`WHERE id = '5'\`. MySQL converts the literal
    rather than the column, the index still works, and the answer is the one intended.
  - **A bare column two relations could own.** Two tables with a \`code\` column of different types
    are two different questions, and there is nothing here to tell them apart.
  - **A comparison against anything but a literal**: a parameter, a variable and another column all
    have types this rule does not pretend to know.
  - **An \`UPDATE\`'s \`SET\`**, which is an assignment: storing \`0\` in a text column stores \`'0'\`,
    which is what was asked for. The conversion that costs something happens in the comparison.`,

  check(ctx) {
    const { tokens } = ctx;
    const assignments = setClause(ctx);

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const operator = tokens[i]!;
      // `SET col = 0` is an assignment: MySQL stores `'0'` in a text column, which is what was
      // asked for. The rule is about the comparison, where the conversion goes the other way.
      if (i > assignments.from && i < assignments.to) continue;

      // `IN` is the same comparison written with a word, once per value — but only when what
      // follows is a list. `IN (SELECT …)` is a query, and the literals inside it belong to its own
      // conditions, not to this column.
      if (kw(operator, "IN") && punct(tokens[i + 1], "(") && !kw(tokens[i + 2], "SELECT")) {
        const found = columnAt(ctx, i - 1);
        const close = matchingParen(tokens, i + 1);
        if (!found || close === -1) continue;
        let depth = 0;
        for (let j = i + 2; j < close; j++) {
          const literal = tokens[j]!;
          if (punct(literal, "(")) depth++;
          else if (punct(literal, ")")) depth--;
          if (depth !== 0) continue;
          if (literal.t !== "num" && literal.t !== "str") continue;
          const problem = mismatch(found.column, literal);
          if (problem) {
            ctx.report(tokens[i - 1]!, `${found.text} is ${found.column.type.raw} and this compares it with ${literal.v}: ${problem}`);
            break;
          }
        }
        continue;
      }

      if (operator.t !== "punct" || !COMPARISONS.has(operator.v)) continue;

      for (const [name, value] of [
        [i - 1, i + 1],
        [i + 1, i - 1],
      ] as const) {
        const literal = tokens[value];
        if (!literal || (literal.t !== "num" && literal.t !== "str")) continue;
        // `a.b = 'x'` puts the dot next to the operator, so the qualified form is read from its name.
        if (punct(tokens[value - 1], ".") || punct(tokens[value + 1], ".")) continue;

        const found = columnAt(ctx, name);
        if (!found) continue;

        const problem = mismatch(found.column, literal);
        if (problem) {
          ctx.report(tokens[name]!, `${found.text} is ${found.column.type.raw} and this compares it with ${literal.v}: ${problem}`);
          break;
        }
      }
    }
  },
};
