import { singleTableQuery } from "../shared/keys.ts";
import { joinNames } from "../shared/names.ts";
import { foldsToOneRow, halfPinnedKey, limitsToOne } from "../shared/rows.ts";
import { kw, kwAny, punct } from "../../syntax/fast/tok.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** What can follow `INTO` and not be a variable: the two forms that write a file. */
const NOT_VARIABLES: ReadonlySet<string> = new Set(["OUTFILE", "DUMPFILE"]);

/**
 * The `INTO` that belongs to this statement, or `-1`.
 *
 * At the statement's own depth, so the `INTO` of a subquery is not mistaken for this one, and both
 * spellings are found: MySQL takes `SELECT a INTO v FROM t` and `SELECT a FROM t INTO v`, and these
 * schemas contain both.
 */
function intoAt(ctx: StatementContext): number {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "INTO")) {
      return kwAny(tokens[i + 1], NOT_VARIABLES) === undefined ? i : -1;
    }
  }
  return -1;
}

export const selectIntoManyRows: Rule = {
  id: "routine/select-into-many-rows",
  group: "routine",
  severity: "warn",
  scope: "statement",
  docs: `A \`SELECT … INTO\` whose query has nothing stopping it from matching twice.

MySQL's answer to two rows here is not the first one: it is error 1172, *Result consisted of more
than one row*, and the procedure stops there. The statement is correct on every dataset where the
search happens to match once — usually the one it was written against — and it breaks the first time
somebody adds the second row.

**It is the same defect as \`query/scalar-subquery-many-rows\`, in the other place a routine reads a
single value**, and it is checked by the same three questions, answered by the same code: does the
\`WHERE\` fix a whole primary key or unique index of the one table read, does an aggregate fold the
rows into one, is there a \`LIMIT 1\`. Any of them is enough for silence.

What it reports is the search that **starts a unique key and abandons it**: some columns of a
declared key fixed, the rest left free. That is not a hypothesis about the data — it is the schema
saying that those remaining columns are what tell two rows apart. Only the catalog knows which
columns those are, which is why this is checkable here and nowhere else.

What it deliberately leaves alone:

  - **A search that touches no unique key at all**, where the schema has no opinion and a finding
    would be a guess about somebody's data rather than a reading of their DDL.
  - **A join, and a table the catalog does not have**, including a temporary one: the claim rests on
    knowing the keys, and where they are unknown there is no claim to make.
  - **\`SELECT … INTO OUTFILE\`**, which writes a file and takes as many rows as it finds.`,

  check(ctx) {
    const { tokens } = ctx;
    if (!kw(tokens[ctx.statement.from], "SELECT")) return;

    const into = intoAt(ctx);
    if (into === -1) return;

    if (foldsToOneRow(tokens, ctx.statement.from, ctx.statement.to)) return;
    if (limitsToOne(tokens, ctx.statement.from, ctx.statement.to)) return;

    const query = singleTableQuery(ctx, ctx.statement.from, ctx.statement.to);
    if (!query) return;

    const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
    const half = halfPinnedKey(fold, query.table, query.pinned);
    if (!half) return;

    ctx.report(
      tokens[ctx.statement.from]!,
      `this SELECT can match more than one row: ${query.table.name} is keyed on (${half.key.join(", ")}), ` +
        `and this fixes ${joinNames(half.held)} but leaves ${joinNames(half.free)} free. ` +
        "MySQL answers error 1172 rather than filling the variables",
    );
  },
};
