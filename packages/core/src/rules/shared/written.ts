/**
 * Every value a statement writes, whichever of the four forms it was written in.
 *
 * `query/write-to-generated-column` needed this much of `INSERT`/`UPDATE` parsed first, and the
 * strict-mode rules that judge a written literal against its column's type need exactly the same
 * four shapes — an `INSERT … VALUES` (row by row), an `INSERT … SET`, an `ON DUPLICATE KEY UPDATE`
 * of either, and an `UPDATE … SET`. A second reading of any of them would drift from the first, and
 * the drift would show up as one rule counting a row the other did not.
 */

import { columnAt, setClause } from "./columns.ts";
import { insertTarget } from "./inserts.ts";
import type { Column, Table } from "../../model/table.ts";
import { kw, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";

/** Is this the whole of a value, and is it the one word MySQL accepts for a generated column? */
export function isDefaultKeyword(tokens: readonly Token[], item: TokenRange): boolean {
  return item.from === item.to && kw(tokens[item.from], "DEFAULT");
}

/**
 * The `col = value` pairs of an assignment list, at its own depth.
 *
 * The three places a write names its columns that way: an `UPDATE`'s `SET`, the `INSERT … SET`
 * form, and the `ON DUPLICATE KEY UPDATE` of either.
 */
export function assignments(tokens: readonly Token[], from: number, to: number): { name: number; value: TokenRange }[] {
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
export function onDuplicateAt(ctx: StatementContext): number {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "ON") && kw(tokens[i + 1], "DUPLICATE")) return i + 4;
  }
  return -1;
}

/** Non-transactional engines, folded to lower case: the ones `STRICT_TRANS_TABLES` does not cover. */
const NON_TRANSACTIONAL_ENGINES: ReadonlySet<string> = new Set(["myisam", "memory", "archive", "csv"]);

/**
 * Does only the first row of a multi-row write fail outright, with the rest merely warned about?
 *
 * `STRICT_TRANS_TABLES` is the half of the default mode that stops a bad value at all, and it only
 * covers transactional storage — InnoDB. MyISAM, MEMORY, ARCHIVE and CSV are not, so a server takes
 * the first row that fails and only warns about the rest of a multi-row `INSERT`, having already
 * committed to writing what it could. A rule built on `STRICT_TRANS_TABLES` failing outright has
 * nothing to say about a row that only warns.
 */
export function firstRowOnly(table: Table): boolean {
  const engine = table.extras?.engine;
  return typeof engine === "string" && NON_TRANSACTIONAL_ENGINES.has(engine.toLowerCase());
}

export interface WrittenValue {
  column: Column;
  table: Table;
  /** Where the value sits, for a diagnostic and for reading the literal out of it. */
  value: TokenRange;
  /** The token that named the column, for a diagnostic that has nowhere else to point. */
  nameToken: Token;
  /** 1-based: which row of a multi-row `VALUES` this came from. Every other form is one row. */
  row: number;
  /** Was this write's own `IGNORE` written? Downgrades the error it would otherwise cause. */
  ignore: boolean;
  /**
   * Is this an `INSERT`'s own write, or an update-shaped one? `ON DUPLICATE KEY UPDATE` counts as
   * the second: it only ever fires on a row that already exists, which is what an `UPDATE` writes to
   * as well — and the one guard that cares about the difference, `AUTO_INCREMENT` accepting `NULL`,
   * is about the server generating a fresh value on `INSERT` and nothing else.
   */
  form: "insert" | "update";
}

/**
 * Every value this statement writes, across the four shapes MySQL accepts one in.
 *
 * `INSERT … SELECT` is not among them: a select list cannot be walked for literals the way a
 * `VALUES` row can, so it produces nothing here. `query/write-to-generated-column` is the one rule
 * that still needs that shape, and it keeps its own reading of it.
 */
export function writtenValues(ctx: StatementContext): WrittenValue[] {
  const { tokens } = ctx;
  const found: WrittenValue[] = [];

  for (const insert of ctx.inserts) {
    const target = insertTarget(ctx, insert);
    if (!target) continue;

    if (target.list && (kw(tokens[target.after], "VALUES") || kw(tokens[target.after], "VALUE"))) {
      const named = splitCommas(tokens, target.list.from + 1, target.list.to - 1);
      let row = 0;
      for (let i = target.after + 1; i <= ctx.statement.to; i++) {
        if (!punct(tokens[i], "(")) continue;
        const close = matchingParen(tokens, i);
        if (close === -1) break;
        row++;
        const values = splitCommas(tokens, i + 1, close - 1);
        named.forEach((item, position) => {
          const nameToken = tokens[item.from];
          const value = values[position];
          if (nameToken?.t !== "id" || !value) return;
          const column = target.table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q === true));
          if (column) found.push({ column, table: target.table, value, nameToken, row, ignore: target.ignore, form: "insert" });
        });
        i = close;
      }
    }

    // `INSERT … SET c = …`, and the `ON DUPLICATE KEY UPDATE` of either form: both name columns of
    // the target, so they are resolved against it rather than against the statement's relations —
    // an `INSERT … SELECT` has the source's tables in there too.
    const lists: { range: TokenRange; form: "insert" | "update" }[] = [];
    const duplicate = onDuplicateAt(ctx);
    if (kw(tokens[target.after], "SET")) {
      lists.push({ range: { from: target.after + 1, to: duplicate === -1 ? ctx.statement.to : duplicate - 5 }, form: "insert" });
    }
    if (duplicate !== -1) lists.push({ range: { from: duplicate, to: ctx.statement.to }, form: "update" });

    for (const { range, form } of lists) {
      for (const pair of assignments(tokens, range.from, range.to)) {
        const nameToken = tokens[pair.name]!;
        const column = target.table.byName.get(ctx.dialect.foldIdentifier(nameToken.v, nameToken.q === true));
        if (column) found.push({ column, table: target.table, value: pair.value, nameToken, row: 1, ignore: target.ignore, form });
      }
    }
  }

  if (kw(tokens[ctx.statement.from], "UPDATE")) {
    const ignore = kw(tokens[ctx.statement.from + 1], "IGNORE");
    const set = setClause(ctx);
    if (set.from !== -1) {
      for (const pair of assignments(tokens, set.from + 1, set.to - 1)) {
        const hit = columnAt(ctx, pair.name);
        if (hit) {
          found.push({
            column: hit.column,
            table: hit.table,
            value: pair.value,
            nameToken: tokens[pair.name]!,
            row: 1,
            ignore,
            form: "update",
          });
        }
      }
    }
  }

  return found;
}
