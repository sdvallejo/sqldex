/**
 * The two decisions the VS Code client makes on its own.
 *
 * Everything else it does is the language client library's, and testing that would be testing
 * Microsoft's code. What is ours is *whether to start a server at all* and *what to start* — the two
 * places where being wrong is silent: a server that indexes a repository nobody asked it to, or one
 * that never comes up with no message about why.
 *
 * No editor is needed for either, which is the reason they are separate files from `extension.js`.
 */

"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { projectRoot } = require("../project.js");
const { isRecentEnough, serverCommand } = require("../server.js");

/** A directory tree, made where the test can afford to make one. */
function tree(...dirs) {
  const root = mkdtempSync(join(tmpdir(), "sqldex-vscode-"));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

// ------------------------------------------------------------ whether to start

test("a config file declares a project by itself", () => {
  const root = tree();
  writeFileSync(join(root, ".sqldex.json"), "{}");
  assert.equal(projectRoot(root), root);
});

test("the Spanish layout declares one on its own, and the English one does not", () => {
  // `tablas/` is called nothing else. `tables/` is a plausible directory in a repository that has
  // nothing to do with a database, so it takes a routines directory beside it to count.
  assert.notEqual(projectRoot(tree("tablas")), undefined);
  assert.equal(projectRoot(tree("tables")), undefined);
  assert.notEqual(projectRoot(tree("tables", "sps")), undefined);
});

test("a repository that merely holds a .sql file starts nothing", () => {
  // The whole point of the guard: an editor opens on its own, and indexing a few thousand files
  // uninvited is what there would otherwise be no way to refuse.
  const root = tree("src");
  writeFileSync(join(root, "src", "migration.sql"), "SELECT 1;");
  assert.equal(projectRoot(root), undefined);
});

test("a folder opened inside a project resolves to the project", () => {
  const root = tree("tablas", "sp");
  assert.equal(projectRoot(join(root, "sp")), root);
});

// -------------------------------------------------------------- what to start

const NOTHING = { exists: () => false, onPath: () => false, nodeVersion: () => undefined };

test("a named server wins over everything, because somebody named it", () => {
  const found = serverCommand("/ext", "/opt/sqldex-lsp", { ...NOTHING, onPath: () => true });
  assert.deepEqual(found.command, "/opt/sqldex-lsp");
  assert.deepEqual(found.args, ["--stdio"]);
});

test("an installed server wins over a checkout, because installing it was the intent", () => {
  const found = serverCommand("/ext", "", { ...NOTHING, onPath: () => true, exists: () => true });
  assert.equal(found.command, "sqldex-lsp");
});

test("a checkout runs its own server, but only one whose dependencies are there", () => {
  const withDeps = serverCommand("/repo/editors/vscode", "", {
    ...NOTHING,
    exists: () => true,
    nodeVersion: () => "v22.18.0",
  });
  assert.equal(withDeps.command, "node");
  assert.deepEqual(withDeps.args, ["/repo/packages/lsp/src/main.ts", "--stdio"]);
  assert.equal(withDeps.problem, undefined);

  // The protocol library is the one thing the server cannot do without, and a clone made by an
  // extension marketplace will not have it.
  const bare = serverCommand("/repo/editors/vscode", "", {
    ...NOTHING,
    exists: (path) => path.endsWith("main.ts"),
  });
  assert.equal(bare.command, "sqldex-lsp");
});

test("a Node too old to read the server's source says so instead of failing quietly", () => {
  const found = serverCommand("/repo/editors/vscode", "", {
    ...NOTHING,
    exists: () => true,
    nodeVersion: () => "v20.11.0",
  });
  assert.equal(found.command, "node", "it is still tried: being told what happened beats silence");
  assert.match(found.problem, /v20\.11\.0/);
});

test("the version test is a comparison and not a string match", () => {
  assert.equal(isRecentEnough("v22.18.0"), true);
  assert.equal(isRecentEnough("v22.17.9"), false);
  assert.equal(isRecentEnough("v24.0.0"), true);
  assert.equal(isRecentEnough("v9.99.0"), false, "9 is not larger than 22, whatever a sort says");
  assert.equal(isRecentEnough(undefined), false);
});

test("finding nothing at all still answers with the installed name", () => {
  // So that what a person sees is their client's own "command not found", naming the thing they
  // would have installed, rather than a message invented here about a path it never tried.
  const found = serverCommand("/ext", "", NOTHING);
  assert.equal(found.command, "sqldex-lsp");
});
