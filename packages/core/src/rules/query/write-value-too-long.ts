import { firstRowOnly, writtenValues } from "../shared/written.ts";
import { literalOf } from "../shared/literals.ts";
import { unquote } from "../../syntax/fast/tok.ts";
import type { Column } from "../../model/table.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

/** Column types the server counts in characters, trimming trailing spaces before it does. */
const CHARACTER_TYPES: ReadonlySet<string> = new Set(["char", "varchar"]);
/** Column types the server counts in bytes, with no trimming. */
const BINARY_TYPES: ReadonlySet<string> = new Set(["binary", "varbinary"]);

/**
 * What a written value would actually store, reading a `_charset'…'` introducer the same way as the
 * string alone — `literalOf` does not, since a charset introducer is not one of the shapes it reads.
 */
function contentOf(tokens: readonly Token[], range: TokenRange): string | undefined {
  const literal = literalOf(tokens, range);
  if (literal && literal.kind !== "null") return literal.text;

  if (range.to === range.from + 1) {
    const introducer = tokens[range.from];
    const str = tokens[range.to];
    if (introducer?.t === "id" && introducer.v.startsWith("_") && str?.t === "str") return unquote(str.v);
  }
  return undefined;
}

function limitProblem(column: Column, content: string): string | undefined {
  const type = column.type.name;
  const limit = Number(column.type.args[0]);
  if (!Number.isFinite(limit)) return undefined;

  if (CHARACTER_TYPES.has(type)) {
    const length = [...content.replace(/ +$/, "")].length;
    return length > limit
      ? `${column.name} is ${column.type.raw} and this value is ${length} character(s) long`
      : undefined;
  }
  if (BINARY_TYPES.has(type)) {
    const length = Buffer.byteLength(content, "utf8");
    return length > limit ? `${column.name} is ${column.type.raw} and this value is ${length} byte(s) long` : undefined;
  }
  return undefined;
}

export const writeValueTooLong: Rule = {
  id: "query/write-value-too-long",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A string literal written into a column too small to hold it.

Strict mode refuses the write outright: error 1406, *Data too long for column 'c'*. \`STRICT_TRANS_TABLES\`
is in the default \`sql_mode\` of both MySQL and MariaDB, so the statement fails on a server left at
its defaults — and passes on one whose \`sql_mode\` was relaxed, which is where a statement like this
gets written and tried.

**Only \`CHAR\`/\`VARCHAR\` and \`BINARY\`/\`VARBINARY\`, and the two count differently — because the
server does.** A character column holds \`n\` *characters*: \`'ñññ'\` fits a \`VARCHAR(3)\` even though
it is more than three bytes. Trailing spaces past the length are dropped with only a note, so
\`'abc   '\` into a \`VARCHAR(3)\` is accepted. A binary column holds \`n\` *bytes* and drops nothing: the
same trailing space in a \`VARBINARY(3)\` is refused. A \`_utf8mb4'…'\`-introduced literal and a double-quoted string are read the same as an ordinary
one, and a bare number is read by its own text: \`1234\` into a \`VARCHAR(3)\` is four characters before
it is anything else.

\`TEXT\`/\`BLOB\` and their siblings are left out on purpose: their limit is in bytes and depends on the
column's charset, which the model does not keep.

What it deliberately leaves alone:

  - **\`INSERT IGNORE\`/\`UPDATE IGNORE\`**, which downgrade the refusal to a warning.
  - **A table the catalog does not hold**, where there is no declared length to compare against.
  - **Anything but a literal** — an expression, a parameter, a variable, \`DEFAULT\` — this rule does
    not guess at a value it cannot read.
  - **A generated column.** \`query/write-to-generated-column\` already refuses the write outright,
    whatever the value; saying the value would also have been too long is not a second defect.
  - **A non-transactional table's second row onward.** On MyISAM, MEMORY, ARCHIVE and CSV,
    \`STRICT_TRANS_TABLES\` refuses a bad value in the first row of a multi-row \`INSERT\` and only warns
    about one in a later row.

A project whose server does not run this mode silences the rule in \`.sqldex.json\` — sqldex has no
\`sql_mode\` setting to read, because a rule never sees a project's config.`,

  check(ctx) {
    for (const value of writtenValues(ctx)) {
      if (value.ignore || value.column.generated) continue;
      if (value.row > 1 && firstRowOnly(value.table)) continue;

      const content = contentOf(ctx.tokens, value.value);
      if (content === undefined) continue;

      const problem = limitProblem(value.column, content);
      if (!problem) continue;
      ctx.report(ctx.tokens[value.value.from]!, `${problem}: the default (strict) sql_mode refuses it`);
    }
  },
};
