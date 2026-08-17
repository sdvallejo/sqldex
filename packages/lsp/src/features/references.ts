/**
 * `textDocument/references`: where a name is used, as opposed to where it is defined.
 *
 * The catalog answers "where does this come from"; this answers "what breaks if I change it",
 * which is the question you actually ask before touching a schema. It is answered by scanning the
 * project rather than by an inverted index kept up to date at startup: the scan costs a fraction of
 * a second and is only paid when somebody asks, so opening a project stays as fast as it was.
 *
 * `targetAt` is shared with rename and is the interesting half. Deciding *what* the cursor is on
 * has to agree with what goto-definition and hover decided, or the same word means three things in
 * three menus — so it is one ordered list of guesses, in the same order they use.
 */

import {
  findReferences,
  identifierAt,
  lineIndex,
  qualifier,
  relation,
  scanReferences,
  type FileReferences,
  type FileSource,
  type RefTarget,
  type Token,
} from "@sqldex/core";
import { readFileSync } from "node:fs";
import type { Location } from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { At } from "../documents.ts";
import type { Workspace } from "../workspace.ts";

/** What the cursor turned out to be on, and how far the search for it reaches. */
export interface Target {
  target: RefTarget;
  /** Whether the search is confined to the file it was asked from. */
  documentOnly: boolean;
  /** The identifier the cursor is on, which is what prepareRename has to highlight. */
  token: Token;
}

/**
 * Every project file, handed back with its text.
 *
 * Lazy on purpose: the scan drops most files on a substring test, and a generator means the ones it
 * drops are never read past the one it is looking at.
 *
 * The open document is served from the buffer rather than from disk — being told who uses a column
 * and shown a line you just deleted is worse than not asking — and it is included even when the
 * catalog has never heard of it, which is the case for a file that has not been saved once yet.
 *
 * It deliberately does **not** go through `Catalog.read`. That cache holds a dozen sources for the
 * benefit of hover and goto; pushing a few thousand files through it would evict everything useful
 * in order to keep the last twelve of a scan, which is exactly backwards.
 */
export function* projectSources(workspace: Workspace, open?: FileSource): Generator<FileSource> {
  const paths = new Set(workspace.catalog.files.keys());
  if (open) paths.add(open.path);
  // Sorted so that two identical questions come back in the same order, which is what makes the
  // result usable as a list to walk down.
  for (const path of [...paths].sort()) {
    if (open && path === open.path) {
      yield open;
      continue;
    }
    try {
      yield { path, src: readFileSync(path, "utf8") };
    } catch {
      // The file went away between the catalog and the read. One missing file is not a reason to
      // fail the whole answer.
    }
  }
}

/**
 * What the cursor is on, as something to look for.
 *
 * The difference from hover is that a column carries its owning table along. Without that, a name
 * like `status` means every `status` of every table in the project, which is not an answer.
 */
export function targetAt(at: At): Target | undefined {
  const found = identifierAt(at.lexed, at.offset);
  if (!found) return undefined;

  const { workspace, analysis, scope } = at;
  const catalog = workspace.catalog;
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const token = found.token;
  const name = token.v;
  const key = fold(name);

  const project = (target: RefTarget): Target => ({ target, documentOnly: false, token });

  // `o.status`: a column of whatever `o` turns out to be. If the qualifier resolves to nothing
  // there is nothing to look for — searching the catalog's `status` instead would answer a
  // question nobody asked, the same way hover refuses to.
  if (found.qualifier !== undefined) {
    const resolved = qualifier(at.resolve, analysis, scope, found.qualifier);
    if (!resolved?.table) return undefined;
    const column = resolved.table.byName.get(key);
    return project({
      // The catalog's spelling, so the placeholder a rename offers is the real one.
      name: column?.name ?? name,
      owner: resolved.table.name,
      // Someone writing `o.status` means that column whether or not it exists, and being told
      // where they wrote it is the point when the answer is "nowhere, it is called state".
      ownerHasColumn: column !== undefined,
    });
  }

  // A parameter or a `DECLARE` lives and dies inside its routine, so the whole project would be the
  // wrong place to look: a name like `pMessage` is declared in hundreds of files and means
  // something different in each.
  const local = scope.byName.get(key);
  if (local && local.kind !== "temp_table") return { target: { name }, documentOnly: true, token };

  // An alias stands for its table, and the uses you want are the table's.
  const aliased = analysis.byAlias.get(key);
  if (aliased?.name !== undefined && fold(aliased.name) !== key) {
    const table = catalog.table(aliased.name);
    if (table) return project({ name: table.name });
  }

  const table = catalog.table(name);
  if (table) return project({ name: table.name });

  const routine = catalog.routine(name);
  if (routine) return project({ name: routine.name });

  const trigger = catalog.trigger(name);
  if (trigger) return project({ name: trigger.name });

  // A bare column, resolved against the statement's own tables the way hover does it. If more than
  // one has it the first wins: the target needs a single owner, and a name sitting in two joined
  // tables is what `names/ambiguous-column` reports anyway.
  for (const candidate of analysis.relations) {
    const resolved = relation(at.resolve, scope, candidate);
    const column = resolved?.table?.byName.get(key);
    if (resolved?.table && column) {
      return project({ name: column.name, owner: resolved.table.name, ownerHasColumn: true });
    }
  }

  // Not in the catalog: still worth answering by name alone. It is what you want for a temporary
  // table, and it is never wrong, only broad.
  return project({ name });
}

/** The files a target's uses have to be looked for in, already narrowed to the ones that have any. */
export function hits(at: At, found: Target): FileReferences[] {
  if (found.documentOnly) {
    const refs = findReferences(at.workspace.dialect, at.text, found.target);
    return refs.length > 0 ? [{ path: at.path, src: at.text, refs }] : [];
  }
  const sources = projectSources(at.workspace, { path: at.path, src: at.text });
  return scanReferences(at.workspace.dialect, sources, found.target);
}

/**
 * Every use of the name under the cursor.
 *
 * `context.includeDeclaration` is not honoured, and the definition is always included. Splitting
 * the two would mean deciding which of the hits *is* the declaration, and for a column that is a
 * line inside a `CREATE TABLE` which the scan reports like any other use — so the flag could only
 * be obeyed by dropping something at random.
 */
export function references(at: At): Location[] | undefined {
  const found = targetAt(at);
  if (!found) return undefined;

  const out: Location[] = [];
  for (const file of hits(at, found)) {
    // One line index per file rather than one per hit: it is a scan of the whole source, and a file
    // with fifty uses would otherwise pay for fifty scans of it.
    const starts = lineIndex(file.src);
    const uri = uriOf(file.path);
    for (const ref of file.refs) out.push({ uri, range: rangeOf(starts, ref) });
  }
  return out;
}
