import { columnAt, setClause } from "../shared/columns.ts";
import { NUMERIC, readsAsNumber, TEXT } from "../shared/literals.ts";
import type { Local } from "../../model/locals.ts";
import type { ColumnType } from "../../model/table.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** Comparisons where a converted operand costs an index and can change the answer. */
const COMPARISONS: ReadonlySet<string> = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "<=>"]);

/**
 * Operators that bind a literal tighter than the comparison does. In `doc->>'$.id' = p_id` the
 * string is the path `->>` reads, not what `p_id` is compared with; in `p = '1' + x` it is half of a
 * sum. Either way the literal is not the operand, and its type says nothing about the comparison.
 */
const BINDS_TIGHTER: ReadonlySet<string> = new Set(["->", "->>", "+", "-", "*", "/", "%", "||", "&", "|", "^"]);

/** A text type compared against a number, which converts the column and costs its index. */
function textMismatch(type: ColumnType, literal: Token): string | undefined {
  if (TEXT.has(type.name.toLowerCase()) && literal.t === "num") {
    return (
      "MySQL converts the column to a number to compare it, which rules out the index on it — and " +
      "makes '007' equal to 7"
    );
  }
  return undefined;
}

/** A numeric type compared against a string that does not read as a number. */
function numericMismatch(type: ColumnType, literal: Token): string | undefined {
  if (NUMERIC.has(type.name.toLowerCase()) && literal.t === "str" && !readsAsNumber(literal.v)) {
    return "MySQL reads the string as a number, which is 0 here, so the comparison is not the one written";
  }
  return undefined;
}

/** The two shapes worth reporting for a column, or `undefined` when the pair is fine. */
function mismatch(type: ColumnType, literal: Token): string | undefined {
  return textMismatch(type, literal) ?? numericMismatch(type, literal);
}

/**
 * The parameter or variable a bare name resolves to, when it declares a type — `undefined` for
 * anything qualified, anything the routine did not declare, and a cursor or temp table, which have
 * no type to compare against.
 *
 * Checked before `columnAt`: inside a routine, MySQL resolves a bare name to its own local before
 * it ever looks at a column of the same name, so a local that shadows one has to be judged by its
 * declared type, not the column's.
 */
function localAt(ctx: StatementContext, i: number): (Local & { type: ColumnType }) | undefined {
  const { tokens, dialect, locals } = ctx;
  const token = tokens[i];
  if (token?.t !== "id") return undefined;
  if (punct(tokens[i - 1], ".") || punct(tokens[i + 1], ".")) return undefined;

  const local = locals.byName.get(dialect.foldIdentifier(token.v, token.q === true));
  if (!local || !local.type || (local.kind !== "param" && local.kind !== "variable")) return undefined;
  return local as Local & { type: ColumnType };
}

/**
 * What a name at this position is being compared as — a local first, a column of the statement's
 * own relations otherwise — with the raw text to name it and the type to judge it against.
 *
 * A local that resolves here is never handed off to `columnAt`: the engine already decided which
 * one the name means, and asking the catalog too would risk a second, contradicting answer.
 */
function subjectAt(ctx: StatementContext, i: number): { text: string; type: ColumnType; local: boolean } | undefined {
  const local = localAt(ctx, i);
  if (local) return { text: ctx.tokens[i]!.v, type: local.type, local: true };

  const found = columnAt(ctx, i);
  return found ? { text: found.text, type: found.column.type, local: false } : undefined;
}

/**
 * Does the same condition also compare this name with a literal zero?
 *
 * `IF p IS NULL OR p = '' OR p = 0 THEN` has already said what `= ''` means: the author knows zero is
 * in, and the `''` adds a second spelling of it rather than a different question. The search stays on
 * the finding's own side of a `THEN`, because the statement this backend cuts for an `IF` also holds
 * the first statement of its body, and a `= 0` there is not part of the condition.
 */
function asksAboutZero(ctx: StatementContext, at: number): boolean {
  const { tokens, dialect } = ctx;
  const { from, to } = ctx.statement;
  let then = -1;
  for (let i = from; i <= to; i++) {
    if (kw(tokens[i], "THEN")) {
      then = i;
      break;
    }
  }
  const [start, end] = then === -1 ? [from, to] : at < then ? [from, then - 1] : [then + 1, to];

  const name = dialect.foldIdentifier(tokens[at]!.v, tokens[at]!.q === true);
  const same = (t: Token | undefined): boolean => t?.t === "id" && dialect.foldIdentifier(t.v, t.q === true) === name;
  const zero = (t: Token | undefined): boolean => t?.t === "num" && Number(t.v) === 0;

  for (let i = start + 1; i < end; i++) {
    const op = tokens[i]!;
    if (op.t !== "punct" || !COMPARISONS.has(op.v)) continue;
    if ((same(tokens[i - 1]) && zero(tokens[i + 1])) || (zero(tokens[i - 1]) && same(tokens[i + 1]))) return true;
  }
  return false;
}

export const literalTypeMismatch: Rule = {
  id: "query/literal-type-mismatch",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A column, variable or parameter compared against a literal of another type.

MySQL does not refuse this. It converts one side and carries on, and **which side it converts is the
whole problem**: comparing a text column with a number converts *the column*, once per row. The index
on it cannot be used, and the comparison stops being the one that was written — \`'007'\`, \`'7 '\` and
\`'7abc'\` all equal \`7\` once both sides are numbers.

The other direction is quieter still. A number compared against a string that is not a number reads
the string as \`0\`, so \`WHERE id = 'A'\` is \`WHERE id = 0\`: not an error, not a match, just a query
that finds nothing for a reason nothing on the line explains.

**Only the catalog knows which side is which.** \`WHERE code = 100\` is fine against an \`int\` and a
scan against a \`varchar\`, and the difference is in a \`CREATE TABLE\` somewhere else in the repository.
A parameter or variable is judged the same way, against its own declared type — and before any column
of the same name, because a bare name inside a routine resolves to the local before it ever resolves
to a column of that name.

**\`IF p_pct IS NULL OR p_pct = '' THEN\`** is the shape worth flagging on a numeric parameter. The
line reads as "nothing was passed", but \`''\` against a number is \`0\`, so it also rejects a
legitimate \`0\` — and at the default \`sql_mode\`, an empty string can never actually reach a numeric
parameter in the first place (\`CALL sp('')\` fails outright, error 1366), so the only value this
comparison can ever be true for is the \`0\` it was not supposed to reject.

What it deliberately leaves alone:

  - **A numeric string against a numeric column**, \`WHERE id = '5'\`. MySQL converts the literal
    rather than the column, the index still works, and the answer is the one intended.
  - **A bare column two relations could own.** Two tables with a \`code\` column of different types
    are two different questions, and there is nothing here to tell them apart.
  - **A comparison against anything but a literal**: two columns, or an expression, have nothing
    fixed on the other side to judge either of them against.
  - **A condition that also asks about zero.** In \`IF p IS NULL OR p = '' OR p = 0 THEN\` the
    author already knows zero is in; the \`''\` is a second spelling of it, not a different question.
  - **The text half on a variable or parameter.** A text column pays for its mismatch with a lost
    index; a local has no index to lose, so only its numeric half — compared against a string that
    is not a number — is worth reporting.
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
        const subject = subjectAt(ctx, i - 1);
        const close = matchingParen(tokens, i + 1);
        if (!subject || close === -1) continue;
        let depth = 0;
        for (let j = i + 2; j < close; j++) {
          const literal = tokens[j]!;
          if (punct(literal, "(")) depth++;
          else if (punct(literal, ")")) depth--;
          if (depth !== 0) continue;
          if (literal.t !== "num" && literal.t !== "str") continue;
          const problem = subject.local ? numericMismatch(subject.type, literal) : mismatch(subject.type, literal);
          if (problem) {
            ctx.report(tokens[i - 1]!, `${subject.text} is ${subject.type.raw} and this compares it with ${literal.v}: ${problem}`);
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
        const beyond = tokens[value < i ? value - 1 : value + 1];
        if (beyond?.t === "punct" && BINDS_TIGHTER.has(beyond.v)) continue;

        const subject = subjectAt(ctx, name);
        if (!subject) continue;

        const problem = subject.local ? numericMismatch(subject.type, literal) : mismatch(subject.type, literal);
        if (problem && literal.t === "str" && asksAboutZero(ctx, name)) break;
        if (problem) {
          ctx.report(tokens[name]!, `${subject.text} is ${subject.type.raw} and this compares it with ${literal.v}: ${problem}`);
          break;
        }
      }
    }
  },
};
