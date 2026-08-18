/**
 * `textDocument/definition` and `textDocument/typeDefinition`.
 *
 * Goto-definition is the same ordered list of guesses hover walks, ending in a place instead of in
 * a paragraph — and it has to be the *same* order, or the word under the cursor means one thing in
 * the hover popup and another in the jump.
 *
 * Type definition is not a pun on the word "type". An `customer_id` is not an `int`, it is *a
 * customer*: in a schema the referenced table is the column's domain, and "where is this thing's
 * type declared" is exactly the question a foreign key answers. Goto-definition is already taken by
 * the column's own line, and it should be — the two answers are both wanted and they are different
 * places.
 */

import { identifierAt, lineIndex, qualifier, relation, type Table } from "@sqldex/core";
import type { Location } from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { At } from "../documents.ts";
import type { Workspace } from "../workspace.ts";

/** Anything the catalog can point at: it records where a name is written, and in which file. */
interface Located {
  nameSpan: { s: number; e: number };
  file?: string;
}

/**
 * A span of a project file, placed.
 *
 * The catalog stores offsets, so the target file has to be read to turn one into a line and a
 * column. That is one read per jump, and the catalog's source cache makes bouncing between two
 * tables re-read nothing.
 */
function locationOf(workspace: Workspace, path: string | undefined, span: { s: number; e: number }): Location | undefined {
  if (path === undefined) return undefined;
  const src = workspace.catalog.read(path);
  if (src === undefined) return undefined;
  return { uri: uriOf(path), range: rangeOf(lineIndex(src), span) };
}

/** Where the catalog says an object is written. */
function definitionOf(workspace: Workspace, item: Located | undefined): Location | undefined {
  return item && locationOf(workspace, item.file, item.nameSpan);
}

/** A column's own line, inside its table's file. */
function columnLocation(workspace: Workspace, table: Table, name: string): Location | undefined {
  const column = table.byName.get(workspace.dialect.foldIdentifier(name, false));
  return column && locationOf(workspace, table.file, column.nameSpan);
}

/** One place, several, or none — which is how the protocol wants it said. */
function answer(hits: Location[]): Location | Location[] | undefined {
  if (hits.length === 0) return undefined;
  return hits.length === 1 ? hits[0] : hits;
}

/** Where the cursor jumps to. */
export function definition(at: At): Location | Location[] | undefined {
  const found = identifierAt(at.lexed, at.offset);
  if (!found) return undefined;

  const { workspace, analysis, scope } = at;
  const catalog = workspace.catalog;
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const name = found.token.v;
  const key = fold(name);

  // `o.status`: the column wins, and it is looked up in whatever `o` turns out to be. If the
  // qualifier resolves to nothing there is nowhere to go — jumping to some other table's `status`
  // would be answering a question nobody asked, the same way hover refuses to.
  if (found.qualifier !== undefined) {
    const resolved = qualifier(at.resolve, analysis, scope, found.qualifier);
    return resolved?.table ? columnLocation(workspace, resolved.table, name) : undefined;
  }

  // A local is declared right here, not in the catalog, so it is the buffer that says where.
  const local = scope.byName.get(key);
  if (local && local.kind !== "temp_table") {
    return { uri: at.document.uri, range: rangeOf(lineIndex(at.text), local.nameSpan) };
  }

  // An alias leads to the table it names, not to itself.
  const aliased = analysis.byAlias.get(key);
  if (aliased?.name !== undefined && fold(aliased.name) !== key) {
    const hit = definitionOf(workspace, catalog.table(aliased.name));
    if (hit) return hit;
  }

  const table = definitionOf(workspace, catalog.table(name));
  if (table) return table;

  // A temporary table created in another procedure: the jump lands on that file's
  // `CREATE TEMPORARY TABLE`, which is exactly what you want to see when querying it after a
  // `CALL`.
  const temp = catalog.tempTable(name);
  if (temp?.nameSpan) {
    const hit = locationOf(workspace, temp.file, temp.nameSpan);
    if (hit) return hit;
  }

  const routine = definitionOf(workspace, catalog.routine(name));
  if (routine) return routine;

  const trigger = definitionOf(workspace, catalog.trigger(name));
  if (trigger) return trigger;

  // A bare column, looked up across the statement's tables. If it sits in several, all of them are
  // returned and the editor picks — that is precisely the case where you do not know which one it
  // came from.
  const hits: Location[] = [];
  for (const candidate of analysis.relations) {
    const resolved = relation(at.resolve, scope, candidate);
    if (!resolved?.table) continue;
    const hit = columnLocation(workspace, resolved.table, name);
    if (hit) hits.push(hit);
  }
  return answer(hits);
}

/**
 * The catalog tables a bare or qualified column reference could belong to.
 *
 * The same resolution `definition` does, kept apart because the two questions end differently: one
 * wants the column's own line, the other wants where its foreign key leads.
 */
function owningTables(at: At, qualifierName: string | undefined): Table[] {
  if (qualifierName !== undefined) {
    const resolved = qualifier(at.resolve, at.analysis, at.scope, qualifierName);
    return resolved?.table ? [resolved.table] : [];
  }

  const tables: Table[] = [];
  for (const candidate of at.analysis.relations) {
    const resolved = relation(at.resolve, at.scope, candidate);
    if (resolved?.table) tables.push(resolved.table);
  }
  return tables;
}

/**
 * From a column to the column its foreign key points at.
 *
 * Inside a `CREATE TABLE` there is nothing to add: the `REFERENCES customers` is right there and
 * plain goto-definition already jumps to it.
 */
export function typeDefinition(at: At): Location | Location[] | undefined {
  const found = identifierAt(at.lexed, at.offset);
  if (!found) return undefined;

  const { workspace } = at;
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const key = fold(found.token.v);

  const hits: Location[] = [];
  const seen = new Set<string>();
  for (const table of owningTables(at, found.qualifier)) {
    const fk = table.byName.get(key)?.fk;
    const target = fk && workspace.catalog.table(fk.table);
    if (!fk || !target) continue;
    // A bare column can sit in two of the statement's tables with a key each, and the same key can
    // be reached twice; what has to be unique is the target, not the route to it.
    const reached = `${fold(target.name)}.${fold(fk.column)}`;
    if (seen.has(reached)) continue;
    seen.add(reached);

    const hit = columnLocation(workspace, target, fk.column);
    if (hit) hits.push(hit);
  }
  return answer(hits);
}
