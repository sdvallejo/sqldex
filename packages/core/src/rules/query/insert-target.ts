/**
 * Where an `INSERT` is pointing, and what its column list is.
 *
 * Both insert rules need exactly this much of the statement parsed, and neither is a place to keep a
 * second copy of it: a disagreement between them about where the column list ends would show up as
 * one rule reporting a column the other counted.
 */

import type { Table } from "../../model/table.ts";
import { columnList, kw, kwAny, punct, qualifiedName } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { StatementContext } from "../rule.ts";

/** Modifiers allowed between the verb and the table name. */
const INSERT_MODIFIERS: ReadonlySet<string> = new Set([
  "INTO",
  "LOW_PRIORITY",
  "DELAYED",
  "HIGH_PRIORITY",
  "IGNORE",
]);

export interface InsertTarget {
  table: Table;
  /** Index of the token after the table name, or after the column list when there is one. */
  after: number;
  /** The explicit column list, when the statement has one. */
  list?: { names: string[]; from: number; to: number };
}

export function insertTarget(ctx: StatementContext, insertIdx: number): InsertTarget | undefined {
  const tokens: readonly Token[] = ctx.tokens;
  let i = insertIdx + 1;
  while (kwAny(tokens[i], INSERT_MODIFIERS)) i++;

  const { name, nextIdx } = qualifiedName(tokens, i);
  if (!name) return undefined;

  // Without the table in the catalog there is nothing to count against, and for a temporary one the
  // columns are not known for certain. `names/unknown-table` already reports a missing one.
  const table = ctx.catalog.table(name);
  if (!table) return undefined;

  // `INSERT INTO t (SELECT ...)`: the parenthesis wraps the query feeding the insert, not a column
  // list. Read as one, every word of the subquery comes out as a column the table does not have.
  const wrapsQuery =
    punct(tokens[nextIdx], "(") &&
    (kw(tokens[nextIdx + 1], "SELECT") ||
      kw(tokens[nextIdx + 1], "WITH") ||
      kw(tokens[nextIdx + 1], "TABLE") ||
      kw(tokens[nextIdx + 1], "VALUES"));

  if (punct(tokens[nextIdx], "(") && !wrapsQuery) {
    const { names, closeIdx } = columnList(tokens, nextIdx);
    if (closeIdx === -1) return undefined;
    return { table, after: closeIdx + 1, list: { names, from: nextIdx, to: closeIdx } };
  }

  return { table, after: nextIdx };
}
