/**
 * `textDocument/hover`: what the name under the cursor is.
 *
 * The whole feature is one ordered list of guesses, and the order is the feature. A word in a
 * statement can be a column, an alias, a variable, a temporary table, a table, a routine, a trigger
 * or a built-in function, and several of those can be true of the same spelling at once. What
 * decides is how *near* the answer is: something declared in this routine beats something in the
 * catalog, and something in the catalog beats a word that merely happens to also be a function.
 *
 * An alias declared in the statement under the cursor is nearer than anything the catalog knows by
 * the same spelling — including another file's temporary table of that name — so it is checked
 * before the catalog gets a say: a name you can see declared three lines up beats one you would have
 * to go searching the project for, even when the far-away one happens to share the spelling.
 */

import { identifierAt, jsonTableColumns, lineIndex, punct, qualifier, relation, tempTable } from "@sqldex/core";
import { basename } from "node:path";
import type { Hover } from "vscode-languageserver";

import { rangeOf } from "../convert.ts";
import type { At } from "../documents.ts";
import {
  builtinDoc,
  columnDoc,
  jsonTableColumnDoc,
  jsonTableDoc,
  localDetail,
  routineDoc,
  sqlBlock,
  tableDoc,
  tempColumnDoc,
  tempTableDoc,
  triggerDoc,
} from "../render.ts";

export function hover(at: At): Hover | undefined {
  const found = identifierAt(at.lexed, at.offset);
  if (!found) return undefined;

  const { workspace, analysis, scope } = at;
  const catalog = workspace.catalog;
  const fold = (name: string) => workspace.dialect.foldIdentifier(name, false);
  const starts = lineIndex(at.text);
  const answer = (value: string): Hover => ({
    contents: { kind: "markdown", value },
    range: rangeOf(starts, found.token),
  });

  const name = found.token.v;
  const key = fold(name);

  /**
   * The basename of the file a temporary table was created in, when that is not this one. A table
   * this file creates itself is never "created in" another file that happens to create one with the
   * same name — the catalog keeps one entry per name, and it need not be this file's.
   */
  const createdIn = (tempName: string): string | undefined => {
    if (scope.byName.get(fold(tempName))?.kind === "temp_table") return undefined;
    const entry = catalog.tempTable(tempName);
    return entry?.file !== undefined && entry.file !== at.path ? basename(entry.file) : undefined;
  };

  /**
   * Where a temporary table's column gets its value: the expression that fills it, when it is this
   * file's own temporary table and the `SELECT` that built it could be read for it; failing that,
   * the file it was created in, when that is a different one. The catalog keeps offsets but not the
   * text of other files, so an expression is only ever shown for a table declared right here.
   */
  const columnOrigin = (tempName: string, columnName: string): string | undefined => {
    const local = scope.byName.get(fold(tempName));
    if (local?.kind === "temp_table" && local.columnOrigins !== undefined) {
      const idx = local.columns?.findIndex((c) => fold(c) === fold(columnName)) ?? -1;
      const span = idx >= 0 ? local.columnOrigins[idx] : undefined;
      if (span !== undefined) return sqlBlock(at.text.slice(span.s, span.e));
    }
    const file = createdIn(tempName);
    return file === undefined ? undefined : `Created in \`${file}\``;
  };

  // Written `x.y`, so the answer can only be about `y` as something belonging to `x`. If `x` does
  // not resolve there is nothing to say — offering the catalog's `y` instead would be answering a
  // question nobody asked.
  if (found.qualifier !== undefined) {
    const resolved = qualifier(at.resolve, analysis, scope, found.qualifier, at.lexed.tokens);
    const column = resolved?.table?.byName.get(key);
    if (resolved?.table && column) return answer(columnDoc(workspace, resolved.table, column));

    if (resolved?.kind === "temp_table") {
      return answer(tempColumnDoc(resolved.name, name, columnOrigin(resolved.name, name)));
    }

    if (resolved?.kind === "derived") {
      // The qualifier's own relation, so a `JSON_TABLE(...)` answers with what its `COLUMNS(...)`
      // says about this one rather than the generic "column of a derived table".
      const qualified = analysis.byAlias.get(fold(found.qualifier));
      const jsonTable = qualified ? jsonTableColumns(at.lexed.tokens, qualified) : undefined;
      const jsonColumn = jsonTable?.columns.find((c) => fold(c.name) === key);
      if (jsonColumn) return answer(jsonTableColumnDoc(found.qualifier, jsonColumn, jsonTable!));

      if (resolved.columns?.some((column) => fold(column) === key)) {
        return answer(`\`${resolved.name}.${name}\` — column of a derived table`);
      }
    }
    return undefined;
  }

  const builtin = (): Hover | undefined => {
    const entry = workspace.dialect.builtin(name);
    return entry ? answer(builtinDoc(entry)) : undefined;
  };

  // An identifier stuck to a `(` is a call, and there the built-in wins: hovering the `FORMAT` of
  // `FORMAT(x, 2)` means the function even if the schema has a table by that name. The project's
  // own routines are checked first, because one defined here shadows the built-in it shares a name
  // with — that is what MySQL does, and a hover that disagreed would be a lie about which code runs.
  if (punct(at.lexed.tokens[found.idx + 1], "(") && !catalog.routine(name)) {
    const asFunction = builtin();
    if (asFunction) return asFunction;
  }

  const local = scope.byName.get(key);
  if (local && local.kind !== "temp_table") {
    return answer(sqlBlock(`${local.name} ${localDetail(local)}`));
  }

  // Hovering an alias shows what it stands for. This runs *before* the catalog is asked whether
  // this spelling is a temporary table of its own, so that a project-wide name does not upstage an
  // alias declared in the very statement being read — see the file's own doc comment.
  const aliased = analysis.byAlias.get(key);

  // A derived table — a real subquery, or a `JSON_TABLE(...)`, which shares its shape — has no
  // `CREATE TABLE` to show, so what it stands for is the columns its query (or its own
  // `COLUMNS(...)`) produces.
  if (aliased?.derived !== undefined && aliased.name === undefined) {
    const jsonTable = jsonTableColumns(at.lexed.tokens, aliased);
    if (jsonTable) return answer(jsonTableDoc(name, jsonTable));

    const resolved = relation(at.resolve, scope, aliased, at.lexed.tokens);
    if (resolved?.columns !== undefined) {
      const columns = resolved.columns;
      const parts = [sqlBlock(`${name}  — derived table, ${columns.length} columns`)];
      if (columns.length > 0) parts.push(columns.join(", "));
      if (resolved.complete !== true) parts.push("Some of its columns could not be worked out from the query.");
      return answer(parts.join("\n\n"));
    }
  }

  // An alias of a real name: a temporary table — this file's own, or another's — before a catalog
  // table, since a temporary table shadows a real one of the same name for as long as the routine
  // that declared it runs.
  if (aliased?.name !== undefined && fold(aliased.name) !== key) {
    const aliasedTemp = tempTable(at.resolve, scope, aliased.name);
    if (aliasedTemp) return answer(tempTableDoc(aliasedTemp, name, true, createdIn(aliasedTemp.name)));

    const table = catalog.table(aliased.name);
    if (table) return answer(tableDoc(workspace, table));
  }

  // A temporary table, whether this file creates it or another one in the project does — reached
  // only once it is settled that this spelling was not somebody else's alias in this statement.
  const temp = tempTable(at.resolve, scope, name);
  if (temp) return answer(tempTableDoc(temp, name, false, createdIn(temp.name)));

  const table = catalog.table(name);
  if (table) return answer(tableDoc(workspace, table));

  const routine = catalog.routine(name);
  if (routine) return answer(routineDoc(routine));

  const trigger = catalog.trigger(name);
  if (trigger) return answer(triggerDoc(trigger));

  // An unqualified column: the first relation in the statement that has one by this name.
  for (const candidate of analysis.relations) {
    const resolved = relation(at.resolve, scope, candidate, at.lexed.tokens);
    const column = resolved?.table?.byName.get(key);
    if (resolved?.table && column) return answer(columnDoc(workspace, resolved.table, column));

    if (resolved?.kind === "temp_table" && resolved.columns?.some((c) => fold(c) === key)) {
      return answer(tempColumnDoc(resolved.name, name, columnOrigin(resolved.name, name)));
    }

    // A `JSON_TABLE(...)` column, referenced bare or hovered right on its own declaration inside
    // `COLUMNS(...)` — both are just this same identifier sitting somewhere in the statement.
    const jsonTable = jsonTableColumns(at.lexed.tokens, candidate);
    const jsonColumn = jsonTable?.columns.find((c) => fold(c.name) === key);
    if (jsonColumn) return answer(jsonTableColumnDoc(candidate.alias, jsonColumn, jsonTable!));
  }

  // Last: functions written without parentheses, such as `CURRENT_TIMESTAMP`. It comes after
  // everything else so that a column or an alias in this statement beats a word that merely happens
  // to be a function's name.
  return builtin();
}
