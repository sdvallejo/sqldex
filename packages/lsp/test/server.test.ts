/**
 * The server, over a real connection.
 *
 * A pair of piped streams rather than a stand-in for a client: the lifecycle is the part of this
 * package that nothing else checks — what `initialize` promises, whether a registration is asked for,
 * what order things arrive in — and a mock of the connection would only test the mock. Everything
 * below goes out as framed JSON-RPC and comes back the same way.
 *
 * Each test copies the fixture project to a temporary directory, because half of what is being
 * tested is the server noticing that files changed underneath it.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  createConnection,
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  CallHierarchyIncomingCallsRequest,
  CallHierarchyPrepareRequest,
  CompletionRequest,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  FileChangeType,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PrepareRenameRequest,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  RenameRequest,
  ShutdownRequest,
  SignatureHelpRequest,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  type CompletionList,
  type Diagnostic,
  type InitializeResult,
  type MarkupContent,
  type ProtocolConnection,
  type Registration,
  type ServerCapabilities,
  type TextDocumentSyncOptions,
} from "vscode-languageserver/node";

import { createServer } from "../src/server.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

/**
 * One end of a pipe.
 *
 * Whatever is written to it comes straight back out as `data`, so one object is both what the client
 * writes and what the server reads. Two of them make a full duplex link with no sockets and no
 * subprocess.
 */
class Pipe extends Duplex {
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.emit("data", chunk);
    done();
  }
}

interface Client {
  connection: ProtocolConnection;
  root: string;
  /** Registrations the server asked the client to make, in the order it asked. */
  registrations: Registration[];
  /**
   * Arm this *before* the action that should cause a publish, then await it. It rejects rather than
   * waiting forever, because the failure this suite is most likely to catch — a change the server
   * never tells anyone about — is indistinguishable from a hang otherwise.
   */
  nextDiagnostics(uri: string): Promise<Diagnostic[]>;
  uri(relative: string): string;
  path(relative: string): string;
  open(relative: string, text: string): void;
  stop(): Promise<void>;
}

function project(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "sqldex-lsp-"));
  cpSync(join(FIXTURES, name), root, { recursive: true });
  return root;
}

/** A server and a client on either end of a pipe, initialized and ready. */
async function start(root: string, options: { watches?: boolean } = {}): Promise<Client> {
  const watches = options.watches ?? true;
  const up = new Pipe();
  const down = new Pipe();

  createServer(createConnection(new StreamMessageReader(up), new StreamMessageWriter(down)));

  const connection = createProtocolConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  const registrations: Registration[] = [];
  const waiting = new Map<string, ((diagnostics: Diagnostic[]) => void)[]>();

  connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
    const waiters = waiting.get(params.uri);
    if (!waiters || waiters.length === 0) return;
    waiting.set(params.uri, []);
    for (const resolve of waiters) resolve(params.diagnostics);
  });
  // The server registers its file watcher with a request, and a request nobody answers is a promise
  // nobody settles.
  connection.onRequest(RegistrationRequest.type, (params) => {
    registrations.push(...params.registrations);
  });
  connection.listen();

  const initialize = await connection.sendRequest(InitializeRequest.type, {
    // `null`, not this process: a server given a parent pid polls it on a timer and exits when it
    // goes away, which is right in production and would keep the test runner's event loop alive.
    processId: null,
    rootUri: pathToFileURL(root).toString(),
    capabilities: watches ? { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } : {},
    workspaceFolders: null,
  });

  const client: Client = {
    connection,
    root,
    registrations,
    uri: (relative) => pathToFileURL(join(root, relative)).toString(),
    path: (relative) => join(root, relative),
    nextDiagnostics(uri) {
      return new Promise((resolve, reject) => {
        const waiters = waiting.get(uri) ?? [];
        waiters.push(resolve);
        waiting.set(uri, waiters);
        // Unreferenced: a test that deliberately expects silence finishes early, and a timer still
        // on the loop would hold the runner open after it.
        setTimeout(() => reject(new Error(`nothing was published for ${uri}`)), 5000).unref();
      });
    },
    open(relative, text) {
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: client.uri(relative), languageId: "sql", version: 1, text },
      });
    },
    async stop() {
      // `shutdown` and then drop the pipe. The `exit` notification is deliberately not sent: its
      // whole job is to end the process, and the process here is the test runner.
      await connection.sendRequest(ShutdownRequest.type, undefined);
      connection.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };

  // `initialized` is what releases the server to build the catalog, so nothing is asked before it.
  connection.sendNotification(InitializedNotification.type, {});
  // The registration is the server's first act after that, and waiting on it is how a test knows the
  // catalog is up without polling for it.
  if (watches) await waitFor(() => registrations.length > 0);
  assertInitialized(initialize);
  return client;
}

function assertInitialized(result: InitializeResult): void {
  assert.equal(result.serverInfo?.name, "sqldex");
}

/** A diagnostic's text. The protocol allows markup here, and nothing this server sends uses it. */
function messageOf(diagnostic: Diagnostic): string {
  return typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
}

/** Polls a condition rather than sleeping a guessed amount, so a slow machine does not fail. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the server");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const SP = "sps/sp_settle_orders.sql";
const SP_TEXT = `CREATE PROCEDURE \`sp_settle_orders\`(IN pCustomerId int)
BEGIN
  INSERT INTO orders (order_id, customer_id, total) VALUES (1, pCustomerId);
END;
`;

// ------------------------------------------------------------------- initialize

test("initialize promises exactly what the server can do", async () => {
  const client = await start(project("shop"));
  const result = await client.connection.sendRequest(InitializeRequest.type, {
    processId: null,
    rootUri: pathToFileURL(client.root).toString(),
    capabilities: {},
    workspaceFolders: null,
  });

  const capabilities: ServerCapabilities = result.capabilities;
  // Declared rather than defaulted: every offset in the engine is a UTF-16 code unit, and a client
  // that assumed otherwise would misplace every range in every file with an accent in it.
  assert.equal(capabilities.positionEncoding, "utf-16");

  assert.equal(capabilities.hoverProvider, true);
  // The dot and nothing else: a menu that also opened on space would be up after every word.
  assert.deepEqual(capabilities.completionProvider?.triggerCharacters, ["."]);
  // Deferring the documentation is the whole reason a list of a few thousand items is cheap.
  assert.equal(capabilities.completionProvider?.resolveProvider, true);
  assert.deepEqual(capabilities.signatureHelpProvider?.triggerCharacters, ["(", ","]);

  assert.equal(capabilities.referencesProvider, true);
  assert.equal(capabilities.callHierarchyProvider, true);
  // Without `prepareProvider` the client opens a rename box over a keyword or a number and only
  // finds out from an empty edit, which is a worse way to learn the same thing.
  assert.deepEqual(capabilities.renameProvider, { prepareProvider: true });

  const sync = capabilities.textDocumentSync as TextDocumentSyncOptions;
  assert.equal(sync.change, TextDocumentSyncKind.Full);
  assert.equal(sync.openClose, true);
  // The text on save is not wanted: what gets updated is the catalog, and the catalog is a statement
  // about what is on disk.
  assert.deepEqual(sync.save, { includeText: false });

  await client.stop();
});

test("a file watcher is registered, because saves are not the only way a file changes", async () => {
  const client = await start(project("shop"));

  const watched = client.registrations.find((r) => r.method === DidChangeWatchedFilesNotification.method);
  assert.ok(watched, "the server never asked the client to watch anything");
  const patterns = (watched.registerOptions as { watchers: { globPattern: string }[] }).watchers.map(
    (w) => w.globPattern,
  );
  assert.deepEqual(patterns, ["**/*.sql", "**/.sqldex.json"]);

  await client.stop();
});

test("a directory that is not a schema project is left alone", async () => {
  // The guard an editor needs and the command does not: starting a server is something an editor
  // does on its own, so a repo with a stray .sql in it must not get indexed uninvited.
  const client = await start(project("plain"), { watches: false });

  const published = client.nextDiagnostics(client.uri("notes.sql")).then(
    () => "published",
    () => "never published",
  );
  client.open("notes.sql", "SELECT * FROM whatever;\n");
  const settled = await Promise.race([
    published,
    new Promise((resolve) => setTimeout(() => resolve("silent"), 400)),
  ]);
  assert.equal(settled, "silent");

  await client.stop();
});

// ------------------------------------------------------------------ diagnostics

test("opening a document reports on it at once, at the right place", async () => {
  const client = await start(project("shop"));

  const published = client.nextDiagnostics(client.uri(SP));
  client.open(SP, SP_TEXT);
  const diagnostics = await published;

  assert.equal(diagnostics.length, 1);
  const [only] = diagnostics;
  assert.equal(only!.code, "query/insert-value-count");
  assert.equal(only!.source, "sqldex");
  // `error` is 1: what the engine itself would reject at execution time.
  assert.equal(only!.severity, 1);
  assert.match(messageOf(only!), /orders gets 2 value\(s\) and expects 3/);
  assert.deepEqual(only!.range, { start: { line: 2, character: 59 }, end: { line: 2, character: 60 } });

  await client.stop();
});

test("an edit moves the finding with it, once typing stops", async () => {
  const client = await start(project("shop"));
  const uri = client.uri(SP);

  const opened = client.nextDiagnostics(uri);
  client.open(SP, SP_TEXT);
  await opened;

  const changed = client.nextDiagnostics(uri);
  client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
    textDocument: { uri, version: 2 },
    // A blank line pushed in above the statement: the same finding, one line down.
    contentChanges: [{ text: SP_TEXT.replace("BEGIN\n", "BEGIN\n\n") }],
  });
  const diagnostics = await changed;

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.range.start.line, 3);

  await client.stop();
});

test("closing a document takes its findings out of the client's problem list", async () => {
  const client = await start(project("shop"));
  const uri = client.uri(SP);

  const opened = client.nextDiagnostics(uri);
  client.open(SP, SP_TEXT);
  assert.equal((await opened).length, 1);

  const cleared = client.nextDiagnostics(uri);
  client.connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } });
  assert.deepEqual(await cleared, []);

  await client.stop();
});

// --------------------------------------------------------------- the catalog moves

test("saving a table changes what an open procedure is told", async () => {
  const client = await start(project("shop"));

  const opened = client.nextDiagnostics(client.uri(SP));
  client.open(SP, SP_TEXT);
  assert.equal((await opened).length, 1);

  // The column the procedure inserts into is dropped from the table, in the editor and on disk.
  const table = "tables/orders.sql";
  const withoutTotal = `CREATE TABLE \`orders\` (
  \`order_id\` int NOT NULL AUTO_INCREMENT,
  \`customer_id\` int NOT NULL,
  PRIMARY KEY (\`order_id\`),
  KEY \`ix_customer\` (\`customer_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;
  client.open(table, withoutTotal);
  writeFileSync(client.path(table), withoutTotal);

  // The procedure is a different document from the one that was saved, and it is the one whose
  // answer changed. A server that only republished the saved file would leave this stale on screen.
  const restated = client.nextDiagnostics(client.uri(SP));
  client.connection.sendNotification(DidSaveTextDocumentNotification.type, {
    textDocument: { uri: client.uri(table) },
  });
  const diagnostics = await restated;

  assert.ok(
    diagnostics.some((d) => d.code === "query/insert-unknown-column" && /total/.test(messageOf(d))),
    `expected the dropped column to be reported, got ${JSON.stringify(diagnostics.map(messageOf))}`,
  );

  await client.stop();
});

test("a file changed outside the editor is picked up from the watcher", async () => {
  const client = await start(project("shop"));

  const opened = client.nextDiagnostics(client.uri(SP));
  client.open(SP, SP_TEXT);
  assert.equal((await opened).length, 1);

  // Nothing an editor would notice: the file is not open, and no buffer was involved. This is the
  // shape of a branch switch.
  const table = "tables/orders.sql";
  writeFileSync(
    client.path(table),
    `CREATE TABLE \`orders\` (
  \`order_id\` int NOT NULL AUTO_INCREMENT,
  \`customer_id\` int NOT NULL,
  PRIMARY KEY (\`order_id\`),
  KEY \`ix_customer\` (\`customer_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`,
  );

  const restated = client.nextDiagnostics(client.uri(SP));
  client.connection.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri: client.uri(table), type: FileChangeType.Changed }],
  });
  const diagnostics = await restated;

  assert.ok(diagnostics.some((d) => d.code === "query/insert-unknown-column"));

  await client.stop();
});

test("a config file appearing rebuilds the project rather than patching it", async () => {
  const client = await start(project("shop"));

  const opened = client.nextDiagnostics(client.uri(SP));
  client.open(SP, SP_TEXT);
  assert.equal((await opened).length, 1);

  writeFileSync(
    client.path(".sqldex.json"),
    JSON.stringify({ diagnostics: { rules: { "query/insert-value-count": "off" } } }),
  );

  const restated = client.nextDiagnostics(client.uri(SP));
  client.connection.sendNotification(DidChangeWatchedFilesNotification.type, {
    changes: [{ uri: client.uri(".sqldex.json"), type: FileChangeType.Created }],
  });
  assert.deepEqual(await restated, []);

  await client.stop();
});

// -------------------------------------------------------------------- features

test("hover, completion and signature help all answer over the wire", async () => {
  // The features have their own tests; what is at stake here is that the requests are wired to
  // them at all, and that a position sent as JSON lands where the engine thinks it does.
  const client = await start(project("shop"));
  const uri = client.uri(SP);

  const opened = client.nextDiagnostics(uri);
  client.open(SP, SP_TEXT);
  await opened;

  // The `orders` of `INSERT INTO orders`, on the third line.
  const onOrders = { line: 2, character: 16 };
  const hovered = await client.connection.sendRequest(HoverRequest.type, {
    textDocument: { uri },
    position: onOrders,
  });
  assert.match((hovered?.contents as MarkupContent).value, /CREATE TABLE `orders`/);

  const completed = (await client.connection.sendRequest(CompletionRequest.type, {
    textDocument: { uri },
    position: onOrders,
  })) as CompletionList;
  assert.ok(
    completed.items.some((entry) => entry.label === "customers"),
    "the catalog's tables were not offered where a table belongs",
  );

  const help = await client.connection.sendRequest(SignatureHelpRequest.type, {
    textDocument: { uri },
    // Inside the `VALUES (` of the same statement, which is not a call: nothing to help with.
    position: { line: 2, character: 60 },
  });
  assert.equal(help, null);

  await client.stop();
});

test("references, rename and call hierarchy all answer over the wire", async () => {
  // Same bargain as above: the answers are checked in `navigation.test.ts`, and what is at stake
  // here is that three requests added after the first version of the protocol are wired at all.
  const client = await start(project("shop"));
  const uri = client.uri(SP);

  const opened = client.nextDiagnostics(uri);
  client.open(SP, SP_TEXT);
  await opened;

  const onOrders = { line: 2, character: 16 };
  const found = await client.connection.sendRequest(ReferencesRequest.type, {
    textDocument: { uri },
    position: onOrders,
    context: { includeDeclaration: true },
  });
  assert.ok(found && found.length > 1, "a table used across the project answered with one place");
  // The answer reaches files the client never opened, which is the point of scanning at all.
  assert.ok(found.some((location) => location.uri !== uri));

  const prepared = await client.connection.sendRequest(PrepareRenameRequest.type, {
    textDocument: { uri },
    position: onOrders,
  });
  assert.deepEqual(prepared, {
    range: { start: { line: 2, character: 14 }, end: { line: 2, character: 20 } },
    placeholder: "orders",
  });

  const edit = await client.connection.sendRequest(RenameRequest.type, {
    textDocument: { uri },
    position: onOrders,
    newName: "purchases",
  });
  assert.ok(edit?.changes, "the rename produced no edit");
  assert.ok(Object.keys(edit.changes).length > 1, "a rename that only touched the open file");

  // On the procedure's own name, in the header.
  const items = await client.connection.sendRequest(CallHierarchyPrepareRequest.type, {
    textDocument: { uri },
    position: { line: 0, character: 20 },
  });
  assert.equal(items?.length, 1);
  assert.equal(items[0]?.name, "sp_settle_orders");

  // Nothing in this project calls it, and "nobody" is an answer rather than a failure.
  const incoming = await client.connection.sendRequest(CallHierarchyIncomingCallsRequest.type, {
    item: items[0]!,
  });
  assert.deepEqual(incoming, []);

  await client.stop();
});
