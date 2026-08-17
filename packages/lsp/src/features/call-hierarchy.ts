/**
 * `textDocument/prepareCallHierarchy` and the two directions that follow it.
 *
 * Stored procedures in a schema repo chain: one leaves a temporary table behind and another queries
 * it after a `CALL`. *If I change this one, who do I break?* is the question that gates every edit
 * to one, and grepping for its name answers it badly — the name also shows up in comments, in
 * strings, and inside longer names.
 *
 * It is the reference scan with one extra condition: a hit counts only if a `CALL` precedes it. The
 * cheap file gate, the whole-token matching and the cost all come from `analysis/references`, which
 * is where they belong.
 */

import {
  identifierAt,
  kw,
  lineIndex,
  parseRoutines,
  qualifiedName,
  scanReferences,
  tokenize,
  type Lexed,
  type Routine,
} from "@sqldex/core";
import {
  SymbolKind,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type Range,
} from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { At } from "../documents.ts";
import type { Workspace } from "../workspace.ts";
import { projectSources } from "./references.ts";

/**
 * What a follow-up request carries back, so neither direction has to work out again what the cursor
 * was on. The protocol types it as `unknown`, which is honest — it is whatever the server put there
 * — so it is read back through a check rather than a cast.
 */
interface ItemData {
  name: string;
}

function nameIn(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const name = (data as Partial<ItemData>).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * A routine as the protocol wants it.
 *
 * `range` and `selectionRange` are both the name. The catalog records where a routine's name is,
 * not where its body ends, and a range that claimed otherwise would send the editor to the wrong
 * place — a lie the client has no way to detect.
 */
function itemOf(workspace: Workspace, routine: Routine): CallHierarchyItem | undefined {
  if (routine.file === undefined) return undefined;
  const src = workspace.catalog.read(routine.file);
  if (src === undefined) return undefined;

  const range = rangeOf(lineIndex(src), routine.nameSpan);
  return {
    name: routine.name,
    kind: routine.kind === "function" ? SymbolKind.Function : SymbolKind.Method,
    detail: routine.signature,
    uri: uriOf(routine.file),
    range,
    selectionRange: range,
    data: { name: routine.name } satisfies ItemData,
  };
}

/** A routine defined in a source, and the offsets it owns. */
interface RoutineRange {
  name: string;
  from: number;
  to: number;
}

/**
 * Routines defined in a source, each with the offset range it owns.
 *
 * A routine's body has no recorded end, so each one runs to the next one's start. In a repo with
 * one procedure per file that is exact, and it stays correct for a file holding several, which is
 * what a triggers file does.
 */
function routineRanges(src: string, lexed: Lexed): RoutineRange[] {
  let routines: readonly Routine[];
  try {
    routines = parseRoutines(src, lexed).routines;
  } catch {
    // A file the routine parser chokes on still has callers worth reporting; they just cannot be
    // attributed to a routine inside it.
    return [];
  }

  return routines.map((routine, i) => ({
    name: routine.name,
    from: routine.nameSpan.s,
    to: routines[i + 1] ? routines[i + 1]!.nameSpan.s - 1 : src.length,
  }));
}

/** The routine an offset falls inside, if any. */
function enclosing(ranges: readonly RoutineRange[], offset: number): string | undefined {
  let found: string | undefined;
  for (const range of ranges) if (offset >= range.from && offset <= range.to) found = range.name;
  return found;
}

/** Every `CALL <name>` in a source, with the routine each one sits inside. */
function callsTo(
  workspace: Workspace,
  src: string,
  name: string,
): { caller: string | undefined; s: number; e: number }[] {
  const lexed = tokenize(src);
  const tokens = lexed.tokens;
  const needle = workspace.dialect.foldIdentifier(name, false);
  const ranges = routineRanges(src, lexed);

  const out: { caller: string | undefined; s: number; e: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // The `CALL` is what separates a call from a mention. The qualified form is not read here
    // because `CALL other_schema.p` still calls `p`, and the schema is not part of the name.
    if (t.t !== "id" || workspace.dialect.foldIdentifier(t.v, t.q === true) !== needle) continue;
    if (!kw(tokens[i - 1], "CALL")) continue;
    out.push({ caller: enclosing(ranges, t.s), s: t.s, e: t.e });
  }
  return out;
}

/** The routine a request is about: the one carried in `data`, or the one under the cursor. */
function subject(workspace: Workspace, item: CallHierarchyItem): Routine | undefined {
  return workspace.catalog.routine(nameIn(item.data) ?? item.name);
}

/**
 * One call site, gathered under the routine at the other end of it.
 *
 * Three `CALL`s from the same procedure are one answer to "who do I break", not three, so the
 * ranges pile up under a single entry and the entries come out in a fixed order.
 */
class ByRoutine {
  readonly #entries = new Map<string, { routine: Routine; ranges: Range[] }>();
  readonly #fold: (name: string) => string;

  constructor(workspace: Workspace) {
    this.#fold = (name) => workspace.dialect.foldIdentifier(name, false);
  }

  add(routine: Routine, range: Range): void {
    const key = this.#fold(routine.name);
    let entry = this.#entries.get(key);
    if (!entry) this.#entries.set(key, (entry = { routine, ranges: [] }));
    entry.ranges.push(range);
  }

  /** Sorted: a list that reshuffles between two identical requests is not one you can navigate. */
  sorted(): { routine: Routine; ranges: Range[] }[] {
    return [...this.#entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, entry]) => entry);
  }
}

/** Whether the cursor is on something with a call hierarchy. */
export function prepareCallHierarchy(at: At): CallHierarchyItem[] | undefined {
  const found = identifierAt(at.lexed, at.offset);
  // A qualified name is a column of something, never a routine.
  if (!found || found.qualifier !== undefined) return undefined;

  const routine = at.workspace.catalog.routine(found.token.v);
  if (!routine) return undefined;

  const one = itemOf(at.workspace, routine);
  return one ? [one] : undefined;
}

/** Who calls this routine. */
export function incomingCalls(
  workspace: Workspace,
  item: CallHierarchyItem,
): CallHierarchyIncomingCall[] | undefined {
  const routine = subject(workspace, item);
  if (!routine) return undefined;

  const found = new ByRoutine(workspace);
  for (const file of scanReferences(workspace.dialect, projectSources(workspace), { name: routine.name })) {
    const starts = lineIndex(file.src);
    for (const call of callsTo(workspace, file.src, routine.name)) {
      // A `CALL` outside any routine — a migration script, a scheduled event — has no caller to
      // hang it on, and inventing one would put a file in the tree as if it were a procedure.
      const caller = call.caller === undefined ? undefined : workspace.catalog.routine(call.caller);
      if (caller) found.add(caller, rangeOf(starts, call));
    }
  }

  return found.sorted().flatMap((entry) => {
    const one = itemOf(workspace, entry.routine);
    return one ? [{ from: one, fromRanges: entry.ranges }] : [];
  });
}

/** What this routine calls. */
export function outgoingCalls(
  workspace: Workspace,
  item: CallHierarchyItem,
): CallHierarchyOutgoingCall[] | undefined {
  const routine = subject(workspace, item);
  if (!routine || routine.file === undefined) return undefined;

  // Read from the file rather than from any open buffer: the request can arrive for a routine that
  // is not the one on screen, and the catalog knows where every one of them lives.
  const src = workspace.catalog.read(routine.file);
  if (src === undefined) return undefined;

  const lexed = tokenize(src);
  const tokens = lexed.tokens;
  const starts = lineIndex(src);
  const ranges = routineRanges(src, lexed);
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const mine = ranges.find((range) => fold(range.name) === fold(routine.name));

  const found = new ByRoutine(workspace);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!kw(t, "CALL")) continue;

    const named = qualifiedName(tokens, i + 1);
    const callee = workspace.catalog.routine(named.name);
    // A file may define several routines; only the calls inside this one are its own.
    const inside = !mine || (t.s >= mine.from && t.s <= mine.to);
    if (callee && named.nameToken && inside) found.add(callee, rangeOf(starts, named.nameToken));
  }

  return found.sorted().flatMap((entry) => {
    const one = itemOf(workspace, entry.routine);
    return one ? [{ to: one, fromRanges: entry.ranges }] : [];
  });
}
