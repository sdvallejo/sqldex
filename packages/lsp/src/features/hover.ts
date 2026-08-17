/**
 * `textDocument/hover`: what the name under the cursor is.
 *
 * The whole feature is one ordered list of guesses, and the order is the feature. A word in a
 * statement can be a column, an alias, a variable, a temporary table, a table, a routine, a trigger
 * or a built-in function, and several of those can be true of the same spelling at once. What
 * decides is how *near* the answer is: something declared in this routine beats something in the
 * catalog, and something in the catalog beats a word that merely happens to also be a function.
 */

import { identifierAt, lineIndex, punct, qualifier, relation, tempTable } from "@sqldex/core";
import { basename } from "node:path";
import type { Hover } from "vscode-languageserver";

import { rangeOf } from "../convert.ts";
import type { At } from "../documents.ts";
import { builtinDoc, columnDoc, localDetail, routineDoc, sqlBlock, tableDoc, triggerDoc } from "../render.ts";

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

  // Written `x.y`, so the answer can only be about `y` as something belonging to `x`. If `x` does
  // not resolve there is nothing to say — offering the catalog's `y` instead would be answering a
  // question nobody asked.
  if (found.qualifier !== undefined) {
    const resolved = qualifier(at.resolve, analysis, scope, found.qualifier);
    const column = resolved?.table?.byName.get(key);
    if (resolved?.table && column) return answer(columnDoc(workspace, resolved.table, column));
    if (resolved?.kind === "temp_table") {
      return answer(`\`${resolved.name}.${name}\` — column of a temporary table`);
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

  // A temporary table, whether this file creates it or another one in the project does.
  const temp = tempTable(at.resolve, scope, name);
  if (temp) {
    const columns = temp.columns ?? [];
    const parts = [sqlBlock(`${temp.name}  — temporary table, ${columns.length} columns`)];
    if (columns.length > 0) parts.push(columns.join(", "));

    const entry = catalog.tempTable(name);
    // Where it was created is the thing you cannot find by searching, because the name is written
    // in every file that touches it and declared in exactly one.
    if (entry?.file !== undefined && entry.file !== at.path) parts.push(`Created in \`${basename(entry.file)}\``);
    return answer(parts.join("\n\n"));
  }

  // Hovering an alias shows the table it stands for: precisely the thing you cannot remember.
  const aliased = analysis.byAlias.get(key);
  if (aliased?.name !== undefined && fold(aliased.name) !== key) {
    const table = catalog.table(aliased.name);
    if (table) return answer(tableDoc(workspace, table));
  }

  const table = catalog.table(name);
  if (table) return answer(tableDoc(workspace, table));

  const routine = catalog.routine(name);
  if (routine) return answer(routineDoc(routine));

  const trigger = catalog.trigger(name);
  if (trigger) return answer(triggerDoc(trigger));

  // An unqualified column: the first relation in the statement that has one by this name.
  for (const candidate of analysis.relations) {
    const resolved = relation(at.resolve, scope, candidate);
    const column = resolved?.table?.byName.get(key);
    if (resolved?.table && column) return answer(columnDoc(workspace, resolved.table, column));
  }

  // Last: functions written without parentheses, such as `CURRENT_TIMESTAMP`. It comes after
  // everything else so that a column or an alias in this statement beats a word that merely happens
  // to be a function's name.
  return builtin();
}
