/**
 * `textDocument/completion` and `completionItem/resolve`.
 *
 * ## The list is chosen by where the cursor is, not filtered afterwards
 *
 * After a `ct.` there is exactly one thing that can legally follow, and offering the whole catalog
 * behind the columns would bury the four names that are actually correct under fifteen hundred that
 * are not. So each cursor context contributes its own set, and only the contexts that genuinely
 * accept anything fall back to everything.
 *
 * ## Ranking, and why built-ins come last
 *
 * A client sorts by `sortText`, so the group's rank goes in as a leading digit. What is in the
 * statement's own scope comes first, because a column of the table you are already reading is the
 * likeliest next word by a wide margin. The built-in functions come last: there are a couple of
 * hundred of them, they are identical in every project, and they are the one group you can look up
 * elsewhere — whereas the name of a table in this schema is exactly what you cannot.
 */

import type { BuiltinFunction, Column, Local, Resolved, Table } from "@sqldex/core";
import { columnNames, fromComment, isEnumLike, lineIndex, qualifier, relation } from "@sqldex/core";
import {
  CompletionItemKind,
  InsertTextFormat,
  type CompletionItem,
  type CompletionList,
  type Range,
} from "vscode-languageserver";

import { rangeOf } from "../convert.ts";
import type { At } from "../documents.ts";
import { argumentsOf, builtinDoc, columnDetail, localDetail, sqlBlock, tableDoc } from "../render.ts";
import type { Workspace } from "../workspace.ts";

/** Group order. Lower comes first; see the note at the top of the file. */
const RANK = {
  value: 0,
  column: 1,
  local: 2,
  tempTable: 3,
  table: 4,
  routine: 5,
  builtin: 6,
} as const;

/**
 * What `completionItem/resolve` is given back so it can find the item again.
 *
 * Only a kind and a name or two: it travels to the client and back on every list, and the whole
 * point of deferring is not to have carried the documentation in the first place.
 */
type ItemData =
  | { k: "table"; n: string }
  | { k: "column"; n: string; t: string }
  | { k: "routine"; n: string }
  | { k: "builtin"; n: string };

/**
 * Collects items, keeps the first of any duplicate, and writes the `sortText`.
 *
 * First-wins is what makes the ordering of the `add` calls meaningful: a project routine is added
 * before the built-ins, so a routine named `FORMAT` in this schema is the one you are offered.
 */
class Items {
  readonly #items: CompletionItem[] = [];
  readonly #seen = new Set<string>();
  readonly #edit: Range;

  constructor(edit: Range) {
    this.#edit = edit;
  }

  add(key: string, rank: number, item: CompletionItem & { insertText?: string }): void {
    if (this.#seen.has(key)) return;
    this.#seen.add(key);

    const { insertText, ...rest } = item;
    this.#items.push({
      ...rest,
      sortText: `${rank}${item.label.toLowerCase()}`,
      // A `textEdit` rather than plain text: it replaces what has been typed so far instead of being
      // appended to it, which is the difference between `cus|` becoming `customers` and `cuscustomers`.
      textEdit: { range: this.#edit, newText: insertText ?? item.label },
    });
  }

  get list(): CompletionList {
    // `isIncomplete: false` because the set does not depend on how much has been typed — the client
    // filters what it already holds instead of asking again on every keystroke.
    return { isIncomplete: false, items: this.#items };
  }
}

function fold(workspace: Workspace, name: string): string {
  return workspace.dialect.foldIdentifier(name, false);
}

function addColumns(out: Items, workspace: Workspace, resolved: Resolved, rank: number): void {
  if (resolved.kind === "temp_table") {
    for (const name of resolved.columns ?? []) {
      out.add(`col:${fold(workspace, resolved.name)}.${fold(workspace, name)}`, rank, {
        label: name,
        kind: CompletionItemKind.Field,
        detail: `column of ${resolved.name}`,
        labelDetails: { description: resolved.name },
      });
    }
    return;
  }

  const table = resolved.table;
  if (!table) return;
  for (const column of table.columns) {
    out.add(`col:${fold(workspace, table.name)}.${fold(workspace, column.name)}`, rank, {
      label: column.name,
      kind: CompletionItemKind.Field,
      detail: columnDetail(column),
      labelDetails: { description: table.name },
      data: { k: "column", n: column.name, t: table.name } satisfies ItemData,
    });
  }
}

function addCatalogTables(out: Items, workspace: Workspace): void {
  for (const table of workspace.catalog.tables.values()) {
    out.add(`tbl:${fold(workspace, table.name)}`, RANK.table, {
      label: table.name,
      kind: CompletionItemKind.Struct,
      detail: `table · ${table.columns.length} cols`,
      data: { k: "table", n: table.name } satisfies ItemData,
    });
  }
}

function addTempTables(out: Items, workspace: Workspace, items: readonly Local[]): void {
  for (const item of items) {
    if (item.kind !== "temp_table") continue;
    out.add(`tmp:${fold(workspace, item.name)}`, RANK.tempTable, {
      label: item.name,
      kind: CompletionItemKind.Struct,
      detail: `temporary table · ${(item.columns ?? []).length} cols`,
    });
  }
}

function addRoutines(out: Items, workspace: Workspace, snippets: boolean): void {
  for (const routine of workspace.catalog.routines.values()) {
    const item: CompletionItem & { insertText?: string } = {
      label: routine.name,
      kind: routine.kind === "function" ? CompletionItemKind.Function : CompletionItemKind.Method,
      detail: argumentsOf(routine.name, routine.signature),
      data: { k: "routine", n: routine.name } satisfies ItemData,
    };

    // With snippet support the parameters go in as placeholders you can tab between; without it the
    // cursor is simply left between the parentheses, which is still better than typing them.
    if (routine.params.length > 0 && snippets) {
      const placeholders = routine.params.map((param, i) => `\${${i + 1}:${param.name}}`);
      item.insertText = `${routine.name}(${placeholders.join(", ")})`;
      item.insertTextFormat = InsertTextFormat.Snippet;
    }

    out.add(`rtn:${fold(workspace, routine.name)}`, RANK.routine, item);
  }
}

/** A project routine of the same name wins: routines are added first and duplicates are dropped. */
function addBuiltins(out: Items, workspace: Workspace): void {
  for (const entry of workspace.dialect.functions.values()) {
    out.add(`rtn:${fold(workspace, entry.name)}`, RANK.builtin, {
      label: entry.name,
      kind: CompletionItemKind.Function,
      // The same shape as a project routine's `detail`, so the two read alike in one list.
      detail: argumentsOf(entry.name, entry.signature),
      labelDetails: { description: entry.category },
      data: { k: "builtin", n: entry.name } satisfies ItemData,
    });
  }
}

function addLocals(out: Items, workspace: Workspace, items: readonly Local[]): void {
  for (const item of items) {
    if (item.kind === "temp_table") continue;
    out.add(`loc:${fold(workspace, item.name)}`, RANK.local, {
      label: item.name,
      kind: item.kind === "cursor" ? CompletionItemKind.Reference : CompletionItemKind.Variable,
      detail: localDetail(item),
    });
  }
}

/**
 * The columns common to the joined relations, for a `USING (...)`.
 *
 * The intersection is what the engine accepts there. When it comes out empty — because one of the
 * relations could not be resolved, and then nothing is common to all of them — it falls back to the
 * union: offering too much beats offering nothing at a position where you cannot type anything else.
 */
function addUsingColumns(out: Items, at: At): void {
  const resolvedList: Resolved[] = [];
  for (const item of at.analysis.relations) {
    const resolved = relation(at.resolve, at.scope, item);
    if (resolved && resolved.kind !== "derived") resolvedList.push(resolved);
  }
  if (resolvedList.length === 0) return;

  const counts = new Map<string, number>();
  const spelling = new Map<string, string>();
  for (const resolved of resolvedList) {
    for (const name of columnNames(resolved)) {
      const key = fold(at.workspace, name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      spelling.set(key, name);
    }
  }

  const common = [...counts.entries()].filter(([, n]) => n === resolvedList.length).map(([key]) => spelling.get(key)!);
  const names = common.length > 0 ? common : [...spelling.values()];
  for (const name of names) {
    out.add(`using:${fold(at.workspace, name)}`, RANK.column, {
      label: name,
      kind: CompletionItemKind.Field,
      detail: common.length > 0 ? "common column" : "column",
    });
  }
}

function addScopeColumns(out: Items, at: At): void {
  for (const item of at.analysis.relations) {
    const resolved = relation(at.resolve, at.scope, item);
    if (resolved) addColumns(out, at.workspace, resolved, RANK.column);
  }
}

/**
 * The values an enum-like column is known to hold, offered as whole literals.
 *
 * Quotes included, and that is the point: the position being handled is the one **before** the
 * opening quote, because the moment a `'` is typed the lexer sees a string running to the end of the
 * file and there is no useful context left. Offering `'A'` entire sidesteps it.
 */
function addColumnValues(out: Items, at: At): void {
  const context = at.analysis.context;
  if (context.column === undefined) return;

  const key = fold(at.workspace, context.column);
  let resolved: Resolved | undefined;
  if (context.columnQualifier !== undefined) {
    resolved = qualifierOf(at, context.columnQualifier);
  } else {
    // Bare: the first relation in the statement that actually has the column.
    for (const item of at.analysis.relations) {
      const candidate = relation(at.resolve, at.scope, item);
      if (candidate?.table?.byName.has(key)) {
        resolved = candidate;
        break;
      }
    }
  }

  const table: Table | undefined = resolved?.table;
  const column: Column | undefined = table?.byName.get(key);
  if (!table || !column || !isEnumLike(column)) return;

  const documented = fromComment(column.comment);
  const observed = at.workspace.catalog
    .observedValues()
    .get(`${fold(at.workspace, table.name)}.${fold(at.workspace, column.name)}`);
  const list = documented ?? observed;
  if (!list) return;

  for (const value of list) {
    out.add(`val:${value.code}`, RANK.value, {
      label: `'${value.code}'`,
      kind: CompletionItemKind.EnumMember,
      detail: value.label ?? `value of ${table.name}.${column.name}`,
      // Only the observed list needs the caveat. A `COMMENT` states the whole set; what the
      // procedures compare against is a lower bound, and offering it without saying so would turn a
      // guess into a rule.
      documentation: documented
        ? undefined
        : {
            kind: "markdown",
            value:
              "Seen in this project's procedures, which is a lower bound: a value none of them mentions is still legal.",
          },
    });
  }
}

function qualifierOf(at: At, name: string): Resolved | undefined {
  return qualifier(at.resolve, at.analysis, at.scope, name);
}

export function complete(at: At, snippets: boolean): CompletionList {
  const starts = lineIndex(at.text);
  // The edit runs from where the typed word starts to the cursor, so accepting an item replaces the
  // prefix rather than being pasted after it.
  const edit: Range = rangeOf(starts, { s: at.analysis.cursor.prefixStart, e: at.offset });
  const out = new Items(edit);
  const context = at.analysis.context;

  const everything = (): void => {
    addScopeColumns(out, at);
    addLocals(out, at.workspace, at.scope.items);
    addTempTables(out, at.workspace, at.scope.items);
    addCatalogTables(out, at.workspace);
    addRoutines(out, at.workspace, snippets);
    addBuiltins(out, at.workspace);
  };

  switch (context.kind) {
    case "qualified": {
      // A qualifier that resolves offers its columns and nothing else: after a `ct.` the rest of the
      // catalog is not a fallback, it is noise.
      const resolved = context.qualifier === undefined ? undefined : qualifierOf(at, context.qualifier);
      if (resolved) addColumns(out, at.workspace, resolved, RANK.column);
      break;
    }
    case "table":
      addTempTables(out, at.workspace, at.scope.items);
      addCatalogTables(out, at.workspace);
      break;
    case "routine":
      addRoutines(out, at.workspace, snippets);
      break;
    case "using":
      addUsingColumns(out, at);
      break;
    case "value_of":
      // Unlike a `ct.`, which can only be a column, the right-hand side of a comparison also takes a
      // variable, a parameter or a call. The values go first and everything else stays behind them;
      // narrowing to the values alone would break a position that is used for everything.
      addColumnValues(out, at);
      everything();
      break;
    case "columns_of": {
      // Through `relation` rather than the catalog directly, so `INSERT INTO tmp_orders (` offers the
      // temporary table's columns too.
      const resolved = relation(at.resolve, at.scope, { name: context.table, offset: at.offset });
      if (resolved) addColumns(out, at.workspace, resolved, RANK.column);
      break;
    }
    case "assignment":
      addScopeColumns(out, at);
      break;
    default:
      everything();
  }

  return out.list;
}

/**
 * Fills in an item's documentation once it has been picked.
 *
 * The expensive part — opening the file and slicing the `CREATE TABLE` out of it — happens here
 * because the client asks for it on the one item that is selected, and not on the fifteen hundred it
 * was handed.
 */
export function resolveItem(workspace: Workspace, item: CompletionItem): CompletionItem {
  const data = item.data as ItemData | undefined;
  if (!data) return item;

  const markdown = (value: string): CompletionItem => ({ ...item, documentation: { kind: "markdown", value } });

  switch (data.k) {
    case "table": {
      const table = workspace.catalog.table(data.n);
      return table ? markdown(tableDoc(workspace, table)) : item;
    }
    case "column": {
      const table = workspace.catalog.table(data.t);
      const column = table?.byName.get(fold(workspace, data.n));
      if (!table || !column) return item;
      const parts = [sqlBlock(`${column.name} ${columnDetail(column)}`)];
      if (column.default !== undefined) parts.push(`DEFAULT \`${column.default}\``);
      if (column.comment !== undefined) parts.push(column.comment);
      parts.push(`In **${table.name}**`);
      return markdown(parts.join("\n\n"));
    }
    case "routine": {
      const routine = workspace.catalog.routine(data.n);
      if (!routine) return item;
      const parts = [sqlBlock(routine.signature)];
      if (routine.doc !== undefined) parts.push(routine.doc);
      return markdown(parts.join("\n\n"));
    }
    case "builtin": {
      const entry: BuiltinFunction | undefined = workspace.dialect.builtin(data.n);
      return entry ? markdown(builtinDoc(entry)) : item;
    }
  }
}
