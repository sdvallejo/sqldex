/**
 * `workspace/symbol` and `textDocument/documentSymbol`.
 *
 * These come almost free from the catalog that already exists, and in exchange they give the
 * project's symbol picker and the open file's outline without writing any UI.
 *
 * The two answer different questions and are shaped differently because of it. The workspace one is
 * a flat list of everything the project defines, filtered by what was typed; the document one is a
 * tree of one file, and its nesting — a table with its columns under it — is the outline.
 */

import { lineIndex, parseDDL, type Span } from "@sqldex/core";
import { SymbolKind, type DocumentSymbol, type SymbolInformation } from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { Analysed } from "../documents.ts";
import { argumentsOf } from "../render.ts";
import type { Workspace } from "../workspace.ts";

/**
 * Cap on symbols returned per query.
 *
 * Without it, the empty query a client sends when the picker opens answers with every table and
 * every routine of the project at once — a few thousand entries nobody scrolls through, serialised
 * on every keystroke until enough has been typed to narrow it.
 */
const MAX_SYMBOLS = 400;

/** Does the name contain the query, ignoring case? */
function matches(name: string, query: string): boolean {
  return query === "" || name.toLowerCase().includes(query.toLowerCase());
}

/** Project symbols matching the query. */
export function workspaceSymbols(workspace: Workspace, query: string): SymbolInformation[] {
  const symbols: SymbolInformation[] = [];

  // One line index per file rather than one per symbol: a file defining a table and its three
  // triggers would otherwise be scanned four times.
  const cache = new Map<string, number[] | undefined>();
  const startsFor = (path: string): number[] | undefined => {
    if (!cache.has(path)) {
      const src = workspace.catalog.read(path);
      cache.set(path, src === undefined ? undefined : lineIndex(src));
    }
    return cache.get(path);
  };

  const emit = (
    item: { name: string; nameSpan: Span; file?: string },
    kind: SymbolKind,
    container?: string,
  ): void => {
    if (symbols.length >= MAX_SYMBOLS || item.file === undefined || !matches(item.name, query)) return;
    const starts = startsFor(item.file);
    if (!starts) return;
    symbols.push({
      name: item.name,
      kind,
      containerName: container,
      location: { uri: uriOf(item.file), range: rangeOf(starts, item.nameSpan) },
    });
  };

  for (const table of workspace.catalog.tables.values()) emit(table, SymbolKind.Struct);
  for (const routine of workspace.catalog.routines.values()) {
    emit(routine, routine.kind === "function" ? SymbolKind.Function : SymbolKind.Method);
  }
  // A trigger says which table it hangs off, because on its own its name is the least memorable
  // thing in the project.
  for (const trigger of workspace.catalog.triggers.values()) emit(trigger, SymbolKind.Event, trigger.table);

  return symbols;
}

/**
 * Structure of the open file: its routines, its tables with their columns nested, its triggers.
 *
 * Read from the buffer and not from the catalog, which is the whole point of an outline: it has to
 * follow the file as it is being written, including the parts that have never been saved.
 */
export function documentSymbols(workspace: Workspace, analysed: Analysed): DocumentSymbol[] {
  const text = analysed.text;
  const starts = lineIndex(text);
  const range = (span: Span) => rangeOf(starts, span);
  const parsed = parseDDL(workspace.dialect, text, analysed.lexed);
  const symbols: DocumentSymbol[] = [];

  // Routines first: in a procedures file they are what the outline is opened for.
  for (const routine of analysed.routines) {
    symbols.push({
      name: routine.name,
      detail: argumentsOf(routine.name, routine.signature),
      kind: routine.kind === "function" ? SymbolKind.Function : SymbolKind.Method,
      // The header rather than the body, whose end the parser does not record. A range claiming to
      // cover the whole procedure and stopping short would make the outline highlight the wrong
      // entry as the cursor moves, which is worse than a range that is honestly small.
      range: range({ s: routine.nameSpan.s, e: routine.headerEnd }),
      selectionRange: range(routine.nameSpan),
    });
  }

  for (const table of parsed.tables) {
    // A procedure's temporary tables are not the file's structure, they are a detail of its body.
    if (table.temporary) continue;
    symbols.push({
      name: table.name,
      detail: `${table.columns.length} columns`,
      kind: SymbolKind.Struct,
      range: range(table.range),
      selectionRange: range(table.nameSpan),
      children: table.columns.map((column) => ({
        name: column.name,
        detail: column.type.raw,
        kind: SymbolKind.Field,
        range: range(column.definitionSpan),
        selectionRange: range(column.nameSpan),
      })),
    });
  }

  for (const trigger of parsed.triggers) {
    symbols.push({
      name: trigger.name,
      detail: `${trigger.timing} ${trigger.event} ON ${trigger.table}`,
      kind: SymbolKind.Event,
      range: range(trigger.nameSpan),
      selectionRange: range(trigger.nameSpan),
    });
  }

  return symbols;
}
