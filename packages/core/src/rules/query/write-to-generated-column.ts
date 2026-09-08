import { columnAt, setClause } from "../shared/columns.ts";
import { insertTarget } from "../shared/inserts.ts";
import { kw, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Column } from "../../model/table.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** Is this the whole of a value, and is it the one word MySQL accepts for a generated column? */
function isDefaultKeyword(tokens: readonly Token[], item: TokenRange): boolean {
  return item.from === item.to && kw(tokens[item.from], "DEFAULT");
}

/**
 * The `col = value` pairs of an assignment list, at its own depth.
 *
 * The three places a write names its columns that way: an `UPDATE`'s `SET`, the `INSERT … SET`
 * form, and the `ON DUPLICATE KEY UPDATE` of either.
 */
function assignments(tokens: readonly Token[], from: number, to: number): { name: number; value: TokenRange }[] {
  const found: { name: number; value: TokenRange }[] = [];
  let depth = 0;
  let start = from;

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && (punct(t, ",") || punct(t, ";") || i === to)) {
      const end = punct(t, ",") || punct(t, ";") ? i - 1 : to;
      // `col = value`, and `t.col = value`, which is how an `UPDATE` over a join writes it.
      let name = start;
      if (punct(tokens[start + 1], ".") && tokens[start + 2]?.t === "id") name = start + 2;
      if (tokens[name]?.t === "id" && punct(tokens[name + 1], "=") && end > name + 1) {
        found.push({ name, value: { from: name + 2, to: end } });
      }
      if (punct(t, ";")) break;
      start = i + 1;
    }
  }
  return found;
}

/** Where an `ON DUPLICATE KEY UPDATE` list starts, at the statement's own depth, or `-1`. */
function onDuplicateAt(ctx: StatementContext): number {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "ON") && kw(tokens[i + 1], "DUPLICATE")) return i + 4;
  }
  return -1;
}

export const writeToGeneratedColumn: Rule = {
  id: "query/write-to-generated-column",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `A write that gives a value to a generated column.

A generated column is computed from the others, and MySQL will not let a statement set it: error
3105, *the value specified for generated column 'c' in table 't' is not allowed*. Not a warning and
not a silent overwrite — the whole statement fails at execution time, so an \`INSERT\` in a branch
that runs once a month fails once a month.

It is what turns up after a column is made generated. The expression moves into the DDL, every
\`INSERT\` that used to compute the value by hand keeps computing it, and each one now names a column
it is no longer allowed to name.

**The one accepted value is the word \`DEFAULT\`**, which tells the server to compute the column
rather than hand it anything, and every form that takes it is checked against a live server rather
than assumed: \`INSERT … VALUES (1, DEFAULT)\`, \`UPDATE … SET c = DEFAULT\` and
\`ON DUPLICATE KEY UPDATE c = DEFAULT\` are all accepted, and any other value in any of those places
is refused. In a multi-row \`VALUES\` it is per row: one row with a real value is enough to fail the
statement, which is why every row is read rather than the first.

An \`INSERT … SELECT\` naming a generated column is always reported: \`DEFAULT\` is not something a
select list can produce, so there is no spelling of that statement the server accepts.

What it leaves alone: a **positional** \`INSERT\` with no column list, where nothing is named and the
count is \`query/insert-select-column-count\`'s question; and a table the catalog does not hold, where
there is no way to know which columns are generated.`,

  check(ctx) {
    const { tokens } = ctx;
    const report = (at: Token, column: Column): void => {
      ctx.report(at, `${column.name} is a generated column: MySQL refuses a write that gives it a value`);
    };

    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target) continue;

      if (target.list) {
        const named = splitCommas(tokens, target.list.from + 1, target.list.to - 1);
        // The rows of a `VALUES`, when that is what feeds the insert: each is read at the position
        // the column list gives, since that is the value the server would be handed for it.
        const rows: TokenRange[][] = [];
        if (kw(tokens[target.after], "VALUES") || kw(tokens[target.after], "VALUE")) {
          for (let i = target.after + 1; i <= ctx.statement.to; i++) {
            if (!punct(tokens[i], "(")) continue;
            const close = matchingParen(tokens, i);
            if (close === -1) break;
            rows.push(splitCommas(tokens, i + 1, close - 1));
            i = close;
          }
        }

        named.forEach((item, position) => {
          const nameToken = tokens[item.from];
          if (nameToken?.t !== "id") return;
          const column = target.table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q === true));
          if (!column?.generated) return;
          // No `VALUES` means a `SELECT` feeding the insert, and a select list cannot say `DEFAULT`.
          // A row too short to reach this position is a count mismatch, which is
          // `query/insert-value-count`'s finding: there is no value here to judge.
          const given =
            rows.length === 0 ||
            rows.some((row) => {
              const value = row[position];
              return value !== undefined && !isDefaultKeyword(tokens, value);
            });
          if (given) report(nameToken, column);
        });
      }

      // `INSERT … SET c = …`, and the `ON DUPLICATE KEY UPDATE` of either form: both name columns of
      // the target, so they are resolved against it rather than against the statement's relations —
      // an `INSERT … SELECT` has the source's tables in there too.
      const lists: TokenRange[] = [];
      const duplicate = onDuplicateAt(ctx);
      if (kw(tokens[target.after], "SET")) {
        lists.push({ from: target.after + 1, to: duplicate === -1 ? ctx.statement.to : duplicate - 5 });
      }
      if (duplicate !== -1) lists.push({ from: duplicate, to: ctx.statement.to });

      for (const list of lists) {
        for (const pair of assignments(tokens, list.from, list.to)) {
          const nameToken = tokens[pair.name]!;
          const column = target.table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q === true));
          if (column?.generated && !isDefaultKeyword(tokens, pair.value)) report(nameToken, column);
        }
      }
    }

    if (!kw(tokens[ctx.statement.from], "UPDATE")) return;
    const set = setClause(ctx);
    if (set.from === -1) return;
    for (const pair of assignments(tokens, set.from + 1, set.to - 1)) {
      const hit = columnAt(ctx, pair.name);
      if (hit?.column.generated && !isDefaultKeyword(tokens, pair.value)) report(tokens[pair.name]!, hit.column);
    }
  },
};
