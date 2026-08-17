/**
 * The language server: what it promises the client, and when it says something.
 *
 * ## Full text sync
 *
 * The client sends the whole document on every change. Incremental sync exists to avoid resending
 * a large file on every keystroke, and the files here are schema definitions and stored procedures —
 * tens of kilobytes, where the send costs less than the bookkeeping to avoid it. The choice is not
 * load-bearing: `TextDocuments` handles both, so it is one line if a measurement ever says otherwise.
 *
 * ## Why diagnostics are pushed and not pulled
 *
 * A pull model would let the client ask only for what it is showing. But a finding here often comes
 * from a *different* file than the one that changed — save a `CREATE TABLE` and a procedure three
 * directories away stops matching it — and a client that only pulls for visible documents would show
 * the stale answer until you happened to open the file. Pushing lets the server say what it knows
 * when it learns it, which is the shape of the problem.
 *
 * ## The debounce
 *
 * Diagnostics are recomputed a quarter of a second after typing stops, per document. Below that the
 * work is wasted on text nobody has finished writing; above it the report feels detached from the
 * edit. Opening a file skips the wait entirely: there is no keystroke to be in the middle of.
 */

import { CONFIG_FILES, resolveProject } from "@sqldex/core";
import { fileURLToPath } from "node:url";
import {
  DidChangeWatchedFilesNotification,
  TextDocumentSyncKind,
  TextDocuments,
  type Connection,
  type InitializeParams,
  type InitializeResult,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { diagnosticsOf } from "./convert.ts";
import { Workspace } from "./workspace.ts";

/** How long after the last keystroke before a document is checked again. */
const DEBOUNCE_MS = 250;

export const SERVER_INFO = { name: "sqldex", version: "0.0.0" } as const;

/**
 * Everything this server can do, stated once.
 *
 * `positionEncoding` is declared rather than left to the default because it is the one thing that
 * would be wrong everywhere at once if it were wrong: every offset in the engine is a UTF-16 code
 * unit, and a client that assumed otherwise would misplace every range in every file with an accent
 * in it — which is a lot of them.
 */
function capabilities(): InitializeResult["capabilities"] {
  return {
    positionEncoding: "utf-16",
    textDocumentSync: {
      openClose: true,
      change: TextDocumentSyncKind.Full,
      // The text is not wanted: the server rereads the file from disk on save anyway, because what
      // it is updating is the catalog, and the catalog is a statement about what is on disk.
      save: { includeText: false },
    },
  };
}

/**
 * Wires a server onto a connection.
 *
 * The connection is the caller's so that a test can drive a real server over a pipe rather than a
 * stand-in for one: the lifecycle — initialize, the capability registration, the order things arrive
 * in — is the part that nothing else checks, and mocking it would test the mock.
 */
export function createServer(connection: Connection): void {
  const documents = new TextDocuments(TextDocument);
  const pending = new Map<string, NodeJS.Timeout>();
  /** Documents already reported on once; the next event from them is a keystroke, not an open. */
  const reported = new Set<string>();

  let workspace: Workspace | undefined;
  let canWatch = false;
  let folder: string | undefined;

  function publish(uri: string): void {
    const timer = pending.get(uri);
    if (timer) {
      clearTimeout(timer);
      pending.delete(uri);
    }

    const document = documents.get(uri);
    if (!document || !workspace) return;

    const src = document.getText();
    connection.sendDiagnostics({ uri, diagnostics: diagnosticsOf(src, workspace.diagnose(src)) });
    reported.add(uri);
  }

  /** Every open document, for when what changed was the schema rather than the text. */
  function publishAll(): void {
    for (const document of documents.all()) publish(document.uri);
  }

  function schedule(uri: string): void {
    const existing = pending.get(uri);
    if (existing) clearTimeout(existing);
    pending.set(
      uri,
      setTimeout(() => {
        pending.delete(uri);
        publish(uri);
      }, DEBOUNCE_MS),
    );
  }

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    folder = rootDirectory(params);
    canWatch = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    // The catalog is not built here. Building it reads every `.sql` file in the project, and the
    // client is blocked until `initialize` answers — so the answer goes out first and the reading
    // happens under `initialized`, where nothing is waiting on it.
    return { capabilities: capabilities(), serverInfo: SERVER_INFO };
  });

  connection.onInitialized(() => {
    // The conservative guard belongs here and not in the command. Starting a server is something an
    // editor does on its own, for any repo that happens to hold a `.sql` file, and indexing a few
    // thousand files uninvited is the thing the guard exists to prevent. Running `sqldex check` is
    // the opposite: naming the command *is* the declaration of intent, so the CLI does not apply it.
    const root = folder ? resolveProject(folder) : undefined;
    if (!root) {
      connection.console.info(
        folder
          ? `sqldex: ${folder} is not a schema project — no catalog built. A .sqldex.json makes it one.`
          : "sqldex: no workspace folder was opened — no catalog built.",
      );
      return;
    }

    workspace = new Workspace(root);
    const { tables, routines, files } = workspace.catalog.stats;
    connection.console.info(
      `sqldex: ${root} — ${count(tables, "table")} and ${count(routines, "routine")} in ${count(files, "file")}.`,
    );

    if (canWatch) {
      // Without this the catalog only learns about a file when that file is saved in this editor. A
      // branch switch, a rebase or another program writing the directory would all go unnoticed, and
      // the server would answer from a schema that no longer exists.
      void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [
          { globPattern: "**/*.sql" },
          ...CONFIG_FILES.map((name) => ({ globPattern: `**/${name}` })),
        ],
      });
    } else {
      connection.console.info(
        "sqldex: this client cannot watch files, so the catalog will only follow what is saved here.",
      );
    }

    // Anything opened while the catalog was being built has been waiting for an answer.
    publishAll();
  });

  documents.onDidChangeContent((event) => {
    // An open is not an edit: there is no keystroke to wait for the end of, and waiting is the
    // difference between a file that is checked when you look at it and one that is checked shortly
    // after.
    if (reported.has(event.document.uri)) schedule(event.document.uri);
    else publish(event.document.uri);
  });

  documents.onDidSave((event) => {
    if (!workspace) return;
    // Reparsing the one file that changed, rather than rebuilding: this is what makes saving feel
    // free in a project of a few thousand files.
    const changed = workspace.refresh(fileURLToPath(event.document.uri));
    // A saved `CREATE TABLE` changes the answer for every file that mentions the table, not just
    // this one. When the catalog did not move, the other documents cannot have changed with it.
    if (changed) publishAll();
    else publish(event.document.uri);
  });

  documents.onDidClose((event) => {
    const timer = pending.get(event.document.uri);
    if (timer) clearTimeout(timer);
    pending.delete(event.document.uri);
    reported.delete(event.document.uri);
    // A closed document keeps its diagnostics in some clients' problem panes forever otherwise.
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  });

  connection.onDidChangeWatchedFiles((params) => {
    if (!workspace) return;

    let changed = false;
    for (const change of params.changes) {
      const path = fileURLToPath(change.uri);
      // The config decides which files are sources at all, so it is not one more changed file: it
      // is a different project, and the catalog is rebuilt rather than patched.
      if (Workspace.isConfigFile(path)) {
        workspace.reload();
        publishAll();
        return;
      }
      if (workspace.refresh(path)) changed = true;
    }
    if (changed) publishAll();
  });

  connection.onShutdown(() => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });

  documents.listen(connection);
  connection.listen();
}

/** The one message a person reads from this server should not say "1 routines". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The directory the client opened.
 *
 * `workspaceFolders` first because it is what a current client sends and the only one that can carry
 * more than one; the deprecated fields are read anyway because a server that only works with the
 * newest clients is a server that fails with no message on an older one.
 *
 * Only the first folder is used. A multi-root window is several projects, and answering across them
 * from one catalog would mean a name in one resolving against a table in another — which is exactly
 * the confusion the schema list exists to prevent.
 */
function rootDirectory(params: InitializeParams): string | undefined {
  const uri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
  if (uri) return fileURLToPath(uri);
  return params.rootPath ?? undefined;
}
