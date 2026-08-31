/**
 * What `activate` hands to the language client, checked against a stub editor.
 *
 * This file exists because of a bug that produced no message anywhere. The client was given a plain
 * output channel; it wanted a **log** channel, called `.onDidChangeLogLevel()` on it during startup,
 * threw — and then crashed a second time inside its own error handler, on `.error()`, which the
 * plain channel does not have either. Both the failure and the notification about it were swallowed,
 * and the extension simply did nothing, in an editor with no diagnostics and an empty log.
 *
 * Nothing here tests the client library. It tests the three things this extension decides and hands
 * over — the channel it creates, the servers it starts, and the documents it claims — because each
 * of them can be wrong in a way that is silent rather than loud.
 */

"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

/** A workspace folder, in the shape the extension reads. */
function folderAt(path, name) {
  return { uri: { scheme: "file", fsPath: path, toString: () => `file://${path}` }, name };
}

/**
 * Loads `extension.js` with `vscode` and the client library replaced, and activates it.
 *
 * The stub is deliberately thin: what the extension asks of the editor is small, and a fatter stub
 * would start testing the fake instead of the code.
 */
function activate(folders) {
  const created = [];
  const started = [];
  const registered = [];

  const vscode = {
    window: {
      createOutputChannel: (name, options) => {
        created.push({ name, options });
        return { info() {}, warn() {}, error() {}, appendLine() {}, dispose() {} };
      },
      showWarningMessage() {},
      showErrorMessage() {},
    },
    workspace: {
      workspaceFolders: folders,
      getConfiguration: () => ({ get: () => "" }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (name) => {
        registered.push(name);
        return { dispose() {} };
      },
      executeCommand() {},
    },
  };

  const client = {
    TransportKind: { stdio: 0 },
    LanguageClient: class {
      constructor(id, name, server, options) {
        started.push({ id, server, options });
      }
      start() {
        return Promise.resolve();
      }
      stop() {
        return Promise.resolve();
      }
    },
  };

  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "vscode" || request === "vscode-languageclient/node") return request;
    return resolve.call(this, request, ...rest);
  };
  require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };
  require.cache["vscode-languageclient/node"] = { id: "lc", filename: "lc", loaded: true, exports: client };

  const extensionPath = join(__dirname, "..");
  delete require.cache[require.resolve("../extension.js")];
  const extension = require("../extension.js");
  try {
    extension.activate({ extensionPath, subscriptions: [] });
  } finally {
    Module._resolveFilename = resolve;
    delete require.cache["vscode"];
    delete require.cache["vscode-languageclient/node"];
  }
  return { created, started, registered };
}

/** A directory that declares a schema project, and one that does not. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "sqldex-activate-"));
  mkdirSync(join(root, "tablas"));
  mkdirSync(join(root, "sp"));
  return root;
}

test("the output channel is a log channel, which is what the client requires of it", () => {
  // A plain channel has no `.onDidChangeLogLevel` and no `.error`, and the client calls both — the
  // first while starting, the second while reporting that starting failed. The extension then goes
  // quiet in every way at once: no server, no diagnostics, no error, nothing in the log.
  const { created } = activate([folderAt(project(), "db")]);
  assert.deepEqual(created[0].options, { log: true });
});

test("one server per project, and none for a folder that is not one", () => {
  const root = project();
  const { started } = activate([folderAt(root, "db"), folderAt(join(root, "sp"), "sp"), folderAt(tmpdir(), "elsewhere")]);

  // Three folders, one project: the second is inside the first, and the third declares nothing.
  assert.equal(started.length, 1);
  // **Which** command it resolved to is deliberately not asserted here. That answer depends on
  // whether the machine running the suite has a `sqldex-lsp` installed — and a workspace install
  // links one into `node_modules/.bin`, which `npm test` puts on the PATH, so this file's own
  // repository is such a machine. The resolution order is tested in `client.test.js`, where the
  // probes are injected and the answer does not depend on where the tests happen to run.
  assert.ok(started[0].server.run.command);
});

test("the document selector carries a string pattern scoped to the project, not a language id", () => {
  // No `language` filter: VS Code's file-association tie-break can hand `.sql` files to a different
  // extension's language mode (MySQL Shell for VS Code is one), and this selector has to keep
  // matching those files regardless of which mode won.
  const root = project();
  const { started } = activate([folderAt(root, "db")]);
  const filter = started[0].options.documentSelector[0];

  assert.equal(filter.language, undefined);
  assert.equal(filter.scheme, "file");
  // A string, because that is the only pattern shape the client can carry through the protocol —
  // an editor `RelativePattern` is dropped on the way, leaving a filter that matches everything.
  assert.equal(typeof filter.pattern, "string");
  assert.equal(filter.pattern, `${root}/**/*.sql`);
});

test("the server is told which folder it serves, since it only ever reads one", () => {
  const root = project();
  const { started } = activate([folderAt(root, "db")]);
  assert.equal(started[0].options.workspaceFolder.uri.fsPath, root);
});

test("rename is offered as a command of its own, and the manifest binds it", () => {
  // VS Code hands a rename to the first provider that answers with anything, and a second SQL
  // language server in the window answers with nothing. The command does not enter that race, so it
  // has to exist and F2 has to reach it.
  const { registered } = activate([folderAt(project(), "db")]);
  assert.ok(registered.includes("sqldex.rename"), `registered: ${registered.join(", ")}`);

  const manifest = require("../package.json");
  assert.ok(manifest.contributes.commands.some((c) => c.command === "sqldex.rename"));
  const binding = manifest.contributes.keybindings.find((k) => k.command === "sqldex.rename");
  assert.equal(binding.key, "f2");
  // `resourceExtname`, not `editorLangId`: the same file-association tie-break that can move a
  // `.sql` file to another extension's language mode would silently take this binding with it.
  assert.match(binding.when, /resourceExtname == \.sql/);
});
