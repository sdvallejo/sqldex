/**
 * The sqldex client for VS Code.
 *
 * Like the client in `editors/nvim`, this implements no feature: the server does the work and
 * decides everything about a project from that project's own `.sqldex.json`. What is left for a
 * client is three questions — how to start it, for which documents, and which directory is the
 * project — and one that only a multi-root editor has to answer.
 *
 * ## One server per folder
 *
 * **The server is single-root by design.** It reads one workspace folder and builds one catalog,
 * because answering across two projects from one catalog would mean a name in one resolving against
 * a table in the other — the confusion the schema list exists to prevent. A window with three
 * schema repos in it therefore gets three servers, each with its own root, rather than one that has
 * to guess which repo a file belongs to. The cost is one process per project, which is what a
 * process per project costs; the alternative is answers that are wrong across folder boundaries and
 * say nothing about it.
 *
 * A folder that is not a schema project gets nothing at all — no process, no indexing — which is
 * the guard `project.js` exists for.
 *
 * Clients are keyed by the **root** rather than by the folder, because those are not the same thing:
 * opening `repo/tables` and `repo/sps` as two folders of one window is two views of one schema, and
 * two servers over one catalog would report every finding twice.
 */

"use strict";

const { commands, window, workspace } = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

const { documentGlob, projectRoot } = require("./project.js");
const { serverCommand } = require("./server.js");

/** The running clients, by the folder each was started for. */
const clients = new Map();

let output;

/**
 * Start a server for one workspace folder, unless its project already has one or it declares none.
 *
 * `workspaceFolder` is what makes the server's `initialize` carry this folder rather than the
 * window's first one, which is the whole of what a multi-root client has to get right: the server
 * reads exactly one, and would otherwise build the wrong project's catalog for every folder but the
 * first.
 */
function start(folder, context) {
  if (folder.uri.scheme !== "file") return;

  const root = projectRoot(folder.uri.fsPath);
  if (root && clients.has(root)) return;
  if (!root) {
    output.info(`${folder.uri.fsPath} is not a schema project — nothing started. A .sqldex.json makes it one.`);
    return;
  }

  const configured = workspace.getConfiguration("sqldex", folder).get("server.path");
  const { command, args, why, problem } = serverCommand(context.extensionPath, configured);
  output.info(`${root}: starting ${[command, ...args].join(" ")} — ${why}`);
  if (problem) {
    output.warn(problem);
    void window.showWarningMessage(`sqldex: ${problem}`);
  }

  const client = new LanguageClient(
    "sqldex",
    "sqldex",
    { run: { command, args, transport: TransportKind.stdio }, debug: { command, args, transport: TransportKind.stdio } },
    {
      // Scoped to the project, not to the folder: a folder opened *inside* a repo still wants every
      // answer the repo's catalog can give.
      //
      // No `language` filter: VS Code assigns exactly one language mode per file extension, decided
      // by an alphabetical tie-break between every installed extension that claims `.sql` — the
      // editor's own built-in `sql` mode is not guaranteed to win it (MySQL Shell for VS Code's own
      // `.sql` language beats it). Filtering on the file itself instead of the mode VS Code happened
      // to pick is what keeps this working regardless of which other extensions are installed.
      documentSelector: [{ scheme: "file", pattern: documentGlob(root) }],
      workspaceFolder: folder,
      outputChannel: output,
      // The server registers `**/*.sql` and the config file once it is up, and this client creates
      // the watchers for that registration itself. Nothing is declared here, because declaring it
      // twice would watch twice.
    },
  );

  clients.set(root, client);
  // Never `void`: a client that fails to start reports through the channel it was given, and if it
  // cannot — which is how this went wrong once already — the failure reaches nobody at all. The
  // notification is the difference between "sqldex is broken" and "sqldex does nothing".
  client.start().catch((error) => {
    clients.delete(root);
    output.error(`could not start the server for ${root}: ${error?.stack ?? error}`);
    void window.showErrorMessage(`sqldex could not start its server: ${error?.message ?? error}`);
  });
}

/**
 * The client whose project holds a document, or `undefined` when none does.
 *
 * By path prefix, because that is what "this file belongs to that project" means here and the client
 * is keyed by the project root it was started for.
 */
function clientFor(uri) {
  if (uri.scheme !== "file") return undefined;
  for (const [root, client] of clients) {
    if (uri.fsPath === root || uri.fsPath.startsWith(`${root}/`)) return client;
  }
  return undefined;
}

/**
 * Renaming, asked of this server directly rather than through the editor's rename.
 *
 * **This exists because of how VS Code picks a rename provider, and it is worth writing down.** For
 * the *prepare* step it walks the providers in order and stops at the first one that does not
 * implement it — `for (…) { if (!provider.resolveRenameLocation) break; … }` — falling back to the
 * plain word under the cursor. For the *edit* it takes the first provider that answers with anything
 * at all, an empty edit included. So a second SQL language server in the same window — and there are
 * several people install, which declare `renameProvider: true` without the prepare half — takes the
 * request and answers with nothing, and the rename does nothing at all, with no error anywhere.
 *
 * Which of the two goes first is decided by registration time, so it is a race: rename works, or
 * quietly does not, depending on which server finished starting first. This command does not enter
 * the race. It asks the server this extension started, and applies what comes back.
 */
async function renameHere() {
  const editor = window.activeTextEditor;
  if (!editor) return;

  const client = clientFor(editor.document.uri);
  if (!client) {
    void window.showInformationMessage("sqldex: this file is not in a project sqldex is serving.");
    return;
  }

  const position = editor.selection.active;
  const params = {
    textDocument: { uri: editor.document.uri.toString() },
    position: { line: position.line, character: position.character },
  };

  const prepared = await client.sendRequest("textDocument/prepareRename", params);
  if (!prepared) {
    void window.showInformationMessage("sqldex: there is nothing here that can be renamed.");
    return;
  }

  const newName = await window.showInputBox({
    value: prepared.placeholder,
    valueSelection: undefined,
    prompt: `Rename ${prepared.placeholder} and every use of it`,
  });
  if (newName === undefined || newName === prepared.placeholder) return;

  const edit = await client.sendRequest("textDocument/rename", { ...params, newName });
  if (!edit) {
    void window.showWarningMessage(`sqldex: ${prepared.placeholder} could not be renamed.`);
    return;
  }

  const applied = await workspace.applyEdit(await client.protocol2CodeConverter.asWorkspaceEdit(edit));
  if (!applied) void window.showWarningMessage("sqldex: the editor refused the rename.");
}

async function stop(root) {
  const client = root === undefined ? undefined : clients.get(root);
  if (!client) return;
  clients.delete(root);
  await client.stop();
}

function activate(context) {
  // A **log** channel, not a plain one: the language client calls `.error()` and `.info()` on
  // whatever it is given, and a plain output channel has neither. Getting this wrong is not a
  // missing line in a log — it is the client crashing inside its own error handler, which swallows
  // both the failure it was reporting and the notification it was about to show. Nothing appears
  // anywhere, which is the worst way for a client to fail.
  output = window.createOutputChannel("sqldex", { log: true });
  context.subscriptions.push(output);

  for (const folder of workspace.workspaceFolders ?? []) start(folder, context);

  context.subscriptions.push(
    workspace.onDidChangeWorkspaceFolders(async (event) => {
      for (const folder of event.removed) await stop(projectRoot(folder.uri.fsPath));
      for (const folder of event.added) start(folder, context);
    }),
  );

  // Naming a different server is a different server, and it is the one setting a running client
  // cannot pick up: everything else it needs comes from the project's own file.
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sqldex.server.path")) void commands.executeCommand("sqldex.restart");
    }),
  );

  context.subscriptions.push(commands.registerCommand("sqldex.rename", renameHere));

  context.subscriptions.push(
    commands.registerCommand("sqldex.restart", async () => {
      for (const key of [...clients.keys()]) await stop(key);
      for (const folder of workspace.workspaceFolders ?? []) start(folder, context);
      output.info("restarted.");
    }),
  );
}

async function deactivate() {
  await Promise.all([...clients.keys()].map(stop));
}

module.exports = { activate, deactivate };
