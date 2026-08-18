/**
 * A catalog seen from inside one file: the project's, plus whatever that file defines itself.
 *
 * ## The problem it exists for
 *
 * A migration script is code that runs against the schema, so it has to be checked against the
 * catalog — and it must not be *part* of it, because its `CREATE TABLE`s are copies of tables
 * already declared elsewhere and cataloguing them would duplicate half the schema. That is what
 * `targets` is for, and it is right.
 *
 * But a migration is also the one kind of file that **introduces** a table and then uses it, in
 * that order, a few lines apart. Checked against a catalog that cannot see the `CREATE TABLE` two
 * statements up, every reference below it is reported as a table that does not exist. On a real
 * deploy directory that is the largest single class of false positive there is, and it is entirely
 * self-inflicted: the definition is right there in the file being read.
 *
 * ## Three decisions
 *
 *   - **The file's own definition wins** over a project table of the same name. The file is what is
 *     going to run; if it says what the table looks like, that is the shape its statements see.
 *   - **The whole-schema derivations delegate untouched**, `tables` and `index` both. A census of
 *     how a column is typed everywhere is a statement about the schema — `schema/divergent-type`
 *     asks "in how many of the tables that have this column" — and a migration is not one more
 *     table in it. Folding one in would move the denominator the answer is measured against, and
 *     would rebuild it on every keystroke besides.
 *   - **The caller composes this, not `check`.** Which catalog a file resolves against is the
 *     question of whoever is running, not of the engine. A sweep of a deploy directory wants a file
 *     to see itself; a caller asking what this file looks like against the schema *as it stands*
 *     wants the opposite, and both are reasonable things to want. A wrapper lets them differ where
 *     a flag on `check` would force one answer on both.
 */

import type { Dialect } from "../dialects/dialect.ts";
import type { Table } from "../model/table.ts";
import type { RuleCatalog } from "../rules/rule.ts";
import { parseDDL } from "../syntax/fast/ddl.ts";
import type { Lexed } from "../syntax/types.ts";

/** Is a DDL parse of this file worth it? Whitespace spelled out because `\s` would allow more. */
const HOLDS_TABLE = /create[ \t\n\v\f\r]+(temporary[ \t\n\v\f\r]+)?table/i;

/**
 * The project's catalog, plus the tables this file declares.
 *
 * Only `CREATE TABLE` is layered on. `ALTER TABLE` — a migration adding a column and then writing
 * to it — is the other half of the same story and is deliberately not here: it is new analysis
 * rather than a lookup, it needs a shape for "the project's table as amended", and it has no
 * bearing on the case this solves.
 *
 * Temporary tables are skipped for the same reason the rule traversal skips them: a
 * `CREATE TEMPORARY TABLE` is a local of the routine that made it, and `locals` already answers
 * for those with far more than a name.
 *
 * @param lexed The file's tokens, already lexed by the caller — every caller has them.
 */
export function withOwnDefinitions(
  base: RuleCatalog,
  dialect: Dialect,
  src: string,
  lexed: Lexed,
): RuleCatalog {
  // The same prefilter the catalog and the rule traversal use, for the same reason: most files in
  // a schema repo are routines, and walking their tokens looking for a `CREATE TABLE` that is not
  // there costs more than the scan that proves it is not.
  if (!HOLDS_TABLE.test(src)) return base;

  const own = new Map<string, Table>();
  for (const table of parseDDL(dialect, src, lexed).tables) {
    if (table.temporary) continue;
    own.set(dialect.foldIdentifier(table.name, table.quoted), table);
  }

  // Nothing declared: hand back the catalog itself rather than a wrapper that only forwards. Most
  // files of a schema repo are routines, and this is the common case.
  if (own.size === 0) return base;

  return {
    table: (name) => (name === undefined ? undefined : own.get(dialect.foldIdentifier(name, false)) ?? base.table(name)),
    routine: (name) => base.routine(name),
    trigger: (name) => base.trigger(name),
    tempTable: (name) => base.tempTable(name),
    // The derivations stay the catalog's. What the buffer redefines is a table the project already
    // has, so a census of every table's columns or of who claims a constraint name is the same
    // answer either way — and recomputing it per keystroke would cost the whole schema.
    tables: base.tables,
    index: (key, build) => base.index(key, build),
  };
}
