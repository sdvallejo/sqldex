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
      documentSelector: [{ scheme: "file", language: "sql", pattern: documentGlob(root) }],
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
