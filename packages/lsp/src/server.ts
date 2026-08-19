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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CodeActionKind,
  DidChangeWatchedFilesNotification,
  TextDocumentSyncKind,
  TextDocuments,
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CodeAction,
  type CompletionItem,
  type CompletionList,
  type Connection,
  type DocumentSymbol,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type InlayHint,
  type Location,
  type SignatureHelp,
  type SymbolInformation,
  type TextDocumentPositionParams,
  type WorkspaceEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { diagnosticsOf } from "./convert.ts";
import { Analyses, at, type Analysed, type At } from "./documents.ts";
import { incomingCalls, outgoingCalls, prepareCallHierarchy } from "./features/call-hierarchy.ts";
import { codeActions } from "./features/code-action.ts";
import { complete, resolveItem } from "./features/completion.ts";
import { definition, typeDefinition } from "./features/definition.ts";
import { hover } from "./features/hover.ts";
import { inlayHints } from "./features/inlay.ts";
import { references } from "./features/references.ts";
import { prepareRename, rename } from "./features/rename.ts";
import { signatureHelp } from "./features/signature.ts";
import { documentSymbols, workspaceSymbols } from "./features/symbols.ts";
import { Workspace } from "./workspace.ts";

/** How long after the last keystroke before a document is checked again. */
const DEBOUNCE_MS = 250;

/**
 * What the client shows about the server it is talking to.
 *
 * Read from the package rather than written down a second time. This number is how somebody tells
 * an old process from the files it came from — a window left open across an upgrade keeps running
 * the server it started with — and a version that has to be remembered by hand is one that stops
 * being true on the first release nobody remembered it on. The `.vsix` carries each package's
 * manifest beside its sources, so the answer is the same from a checkout and from an installed
 * extension.
 */
function serverVersion(): string {
  try {
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(manifest).version;
  } catch {
    // Running from somewhere that did not bring the manifest along. Saying so beats a number that
    // would be a lie, since the whole point of this string is telling two builds apart.
    return "unknown";
  }
}

export const SERVER_INFO = { name: "sqldex", version: serverVersion() } as const;

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
    hoverProvider: true,
    completionProvider: {
      // The dot, and only the dot. Opening the menu on space as well was considered — it is what
      // makes a menu appear on its own after `FROM ` — but the same rule opens it after *every*
      // space in the file, and a list that is always up is a list nobody reads.
      triggerCharacters: ["."],
      // The heavy documentation, which for a table is its whole `CREATE TABLE`, is deferred to
      // `resolve`: the client asks for it on the selected item and not on the whole list.
      resolveProvider: true,
    },
    signatureHelpProvider: { triggerCharacters: ["(", ","] },
    definitionProvider: true,
    // A column's foreign key, which is the schema's answer to "what kind of thing is this".
    typeDefinitionProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    inlayHintProvider: true,
    // The kinds are declared so that a client which filters by them knows what is here to ask for:
    // the generative rewrites, cursor-triggered, and the quick fixes anchored to a diagnostic.
    codeActionProvider: { codeActionKinds: [CodeActionKind.RefactorRewrite, CodeActionKind.QuickFix] },
    referencesProvider: true,
    // `prepareProvider` is what stops the client from opening a rename box over a keyword or a
    // number. Without it every position in the file looks renameable until the edit comes back
    // empty, which is a worse way to learn the same thing.
    renameProvider: { prepareProvider: true },
    callHierarchyProvider: true,
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

  const analyses = new Analyses();

  let workspace: Workspace | undefined;
  let canWatch = false;
  let folder: string | undefined;
  /**
   * Whether the client can expand `${1:name}` placeholders. Asked once at startup, because a server
   * that guessed wrong would insert the literal text of a snippet into somebody's procedure.
   */
  let snippets = false;

  function publish(uri: string): void {
    const timer = pending.get(uri);
    if (timer) {
      clearTimeout(timer);
      pending.delete(uri);
    }

    const document = documents.get(uri);
    if (!document || !workspace) return;

    const src = document.getText();
    // A project can ask for the catalog without the underlines. Sending an empty list rather than
    // returning early is what makes turning it off *clear* the screen: the config is reloaded and
    // every open document republished, and a silent return would leave the old findings frozen
    // where they are, outliving the setting that produced them.
    const found = workspace.config.diagnostics.enabled ? diagnosticsOf(src, workspace.diagnose(src)) : [];
    connection.sendDiagnostics({ uri, diagnostics: found });
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
    snippets = params.capabilities.textDocument?.completion?.completionItem?.snippetSupport === true;
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
    // The rule count is here so that "which engine is this?" is one line away. A server outlives
    // the copy it was started from — reinstalling an editor client does not restart the process it
    // already has — and the symptom of running yesterday's engine is a rule that quietly does not
    // fire. A number that does not match `sqldex rules` says so at a glance.
    connection.console.info(
      `sqldex: ${root} — ${count(tables, "table")} and ${count(routines, "routine")} in ${count(files, "file")}, ` +
        `${count(workspace.registry.all().length, "rule")}.`,
    );
    // Worth a line of its own: everything else about this server keeps working, so the one symptom
    // is silence, and silence is what a person reads as "it is not running".
    if (!workspace.config.diagnostics.enabled) {
      connection.console.info(
        "sqldex: diagnostics are off for this project — .sqldex.json sets diagnostics.enabled to false.",
      );
    }

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

  /**
   * The shared opening of every position request: find the document, and work out what is at the
   * cursor. A request that arrives for a document the server does not hold — a race with a close, or
   * a client asking about a file it never opened — is answered with nothing rather than an error,
   * because there is no failure here to report.
   */
  function positioned(params: TextDocumentPositionParams): At | undefined {
    const document = documents.get(params.textDocument.uri);
    if (!document || !workspace) return undefined;
    return at(workspace, analyses.of(document), params.position);
  }

  /** The same, for the two requests that are about a whole document rather than a place in one. */
  function analysed(uri: string): Analysed | undefined {
    const document = documents.get(uri);
    return document && workspace ? analyses.of(document) : undefined;
  }

  connection.onHover((params): Hover | undefined => {
    const here = positioned(params);
    return here && hover(here);
  });

  connection.onSignatureHelp((params): SignatureHelp | undefined => {
    const here = positioned(params);
    return here && signatureHelp(here);
  });

  connection.onCompletion((params): CompletionList => {
    const here = positioned(params);
    return here ? complete(here, snippets) : { isIncomplete: false, items: [] };
  });

  connection.onCompletionResolve((item): CompletionItem => (workspace ? resolveItem(workspace, item) : item));

  connection.onDefinition((params): Location | Location[] | undefined => {
    const here = positioned(params);
    return here && definition(here);
  });

  connection.onTypeDefinition((params): Location | Location[] | undefined => {
    const here = positioned(params);
    return here && typeDefinition(here);
  });

  connection.onDocumentSymbol((params): DocumentSymbol[] | undefined => {
    const document = analysed(params.textDocument.uri);
    return document && workspace ? documentSymbols(workspace, document) : undefined;
  });

  // The one request in the protocol that is about the project and not about a file, which is why it
  // needs no open document: the picker is opened before anything has been opened at all.
  connection.onWorkspaceSymbol((params): SymbolInformation[] => {
    return workspace ? workspaceSymbols(workspace, params.query) : [];
  });

  connection.languages.inlayHint.on((params): InlayHint[] => {
    const document = analysed(params.textDocument.uri);
    return document && workspace ? inlayHints(workspace, document, params.range) : [];
  });

  connection.onCodeAction((params): CodeAction[] => {
    // The client sends a selection, and what the cursor-triggered actions are about is where it
    // starts. Reading the end instead would make selecting a whole line offer the actions of
    // whatever follows it. The quick fixes are not about the cursor at all — the client already
    // narrowed `context.diagnostics` to the ones overlapping the selection.
    const here = positioned({ textDocument: params.textDocument, position: params.range.start });
    return here ? codeActions(here, params.context.diagnostics) : [];
  });

  connection.onReferences((params): Location[] | undefined => {
    const here = positioned(params);
    return here && references(here);
  });

  connection.onPrepareRename((params) => {
    const here = positioned(params);
    return here && prepareRename(here);
  });

  connection.onRenameRequest((params): WorkspaceEdit | undefined => {
    const here = positioned(params);
    return here && rename(here, params.newName);
  });

  // The three call-hierarchy requests hang off `languages` rather than off the connection itself,
  // which is where the library puts everything added to the protocol after its first version.
  connection.languages.callHierarchy.onPrepare((params): CallHierarchyItem[] | null => {
    const here = positioned(params);
    return (here && prepareCallHierarchy(here)) ?? null;
  });

  // The follow-ups carry the item rather than a position, so they need no open document: the
  // hierarchy of a procedure is a fact about the project, and answering it should not depend on
  // which file happens to be on screen.
  connection.languages.callHierarchy.onIncomingCalls((params): CallHierarchyIncomingCall[] | null => {
    return (workspace && incomingCalls(workspace, params.item)) ?? null;
  });

  connection.languages.callHierarchy.onOutgoingCalls((params): CallHierarchyOutgoingCall[] | null => {
    return (workspace && outgoingCalls(workspace, params.item)) ?? null;
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
    analyses.forget(event.document.uri);
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
