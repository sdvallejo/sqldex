/**
 * What has been worked out about an open document, and what has been worked out about one place in
 * it.
 *
 * Two different lifetimes, which is why there are two things here.
 *
 * **Per document**, the token stream and the routines defined in the file. Lexing a file is cheap,
 * but doing it in `didChange` would mean doing it on every keystroke whether or not anybody asked a
 * question. Here it is computed the first time a feature wants it and thrown away when the text
 * changes, so a burst of typing that asks nothing costs nothing.
 *
 * **Per request**, the statement around the cursor and the locals visible from it. Those depend on
 * *where* in the file the question is, so there is nothing to cache across requests — but hover,
 * signature help and completion each need all of it, and each computing it separately is how three
 * features drift into disagreeing about what the cursor is on.
 */

import type { Analysis, Lexed, Locals, ResolveContext, Routine } from "@sqldex/core";
import { analyze, collect, parseRoutines, tokenize } from "@sqldex/core";
import { fileURLToPath } from "node:url";
import type { Position } from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { Workspace } from "./workspace.ts";

/** One open document, with what is derived from its text. */
export class Analysed {
  readonly document: TextDocument;
  readonly lexed: Lexed;
  #routines?: readonly Routine[];

  constructor(document: TextDocument) {
    this.document = document;
    this.lexed = tokenize(document.getText());
  }

  get text(): string {
    return this.document.getText();
  }

  /**
   * Kept behind a getter because most questions never need it: hovering a table name or completing
   * after `FROM` does not care what routines the file defines, and parsing a body is the expensive
   * half of reading a file.
   */
  get routines(): readonly Routine[] {
    this.#routines ??= parseRoutines(this.text, this.lexed).routines;
    return this.#routines;
  }
}

/**
 * The derived state of every open document, discarded the moment its text moves.
 *
 * Keyed by URI with the version alongside rather than by `uri@version`, so a document that has been
 * edited fifty times holds one entry and not fifty.
 */
export class Analyses {
  readonly #byUri = new Map<string, { version: number; analysed: Analysed }>();

  of(document: TextDocument): Analysed {
    const cached = this.#byUri.get(document.uri);
    if (cached && cached.version === document.version) return cached.analysed;

    const analysed = new Analysed(document);
    this.#byUri.set(document.uri, { version: document.version, analysed });
    return analysed;
  }

  forget(uri: string): void {
    this.#byUri.delete(uri);
  }
}

/** Everything a feature needs to answer a question about one position. */
export interface At {
  workspace: Workspace;
  document: TextDocument;
  /** The document's path on disk, which is how the catalog names the file the same document is. */
  path: string;
  text: string;
  lexed: Lexed;
  /** 0-based, in UTF-16 code units — the same offsets the engine uses, with nothing to convert. */
  offset: number;
  /** The statement around the cursor: its relations, its aliases, and what belongs at the cursor. */
  analysis: Analysis;
  /** Parameters, variables, cursors and temporary tables visible from here. */
  scope: Locals;
  resolve: ResolveContext;
}

export function at(workspace: Workspace, analysed: Analysed, position: Position): At {
  const text = analysed.text;
  const offset = analysed.document.offsetAt(position);
  const tokens = analysed.lexed.tokens;

  return {
    workspace,
    document: analysed.document,
    path: fileURLToPath(analysed.document.uri),
    text,
    lexed: analysed.lexed,
    offset,
    analysis: analyze(workspace.dialect, text, tokens, offset),
    scope: collect(workspace.dialect, text, tokens, offset, analysed.routines),
    resolve: workspace.resolveContext,
  };
}
