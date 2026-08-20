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
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { bundle } = require("../bundle-server.js");
const { documentGlob, projectRoot } = require("../project.js");
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

test("the document glob is a string, and a Windows path is turned into one", () => {
  // Not a `RelativePattern`: the client converts every filter through the protocol, whose relative
  // pattern has a *string* baseUri, and an editor `RelativePattern` fails that test silently — the
  // filter survives with no pattern at all and the server starts answering about every project in
  // the window. A string is carried through untouched.
  assert.equal(typeof documentGlob("/repo/db"), "string");
  assert.equal(documentGlob("/repo/db"), "/repo/db/**/*");
  assert.equal(documentGlob("C:\\Users\\me\\db"), "C:/Users/me/db/**/*");
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
  assert.deepEqual(withDeps.args, ["--conditions=development", "/repo/packages/lsp/src/main.ts", "--stdio"]);
  assert.equal(withDeps.problem, undefined);

  // The protocol library is the one thing the server cannot do without, and a checkout whose
  // dependencies were never installed does not have it. With no bundle either, there is nothing
  // left to try.
  const bare = serverCommand("/repo/editors/vscode", "", {
    ...NOTHING,
    exists: (path) => path === "/repo/packages/lsp/src/main.ts",
  });
  assert.equal(bare.command, "sqldex-lsp");
});

test("a packaged extension runs the copy it was packaged with", () => {
  // No checkout above it, nothing on the PATH: this is every machine that installed the `.vsix` and
  // has never seen the repository, and it is the case the bundle exists for.
  const found = serverCommand("/home/someone/.vscode/extensions/sqldex", "", {
    ...NOTHING,
    exists: (path) => path.includes("/server/"),
    nodeVersion: () => "v22.18.0",
  });
  assert.equal(found.command, "node");
  assert.match(found.args[1], /server\/lsp\/src\/main\.ts$/);
});

test("a checkout beats the bundle, because the bundle is a copy taken from it", () => {
  // Both present means somebody is working on the server, and running last week's copy of what they
  // just edited is the kind of wrong that takes an afternoon to notice.
  const found = serverCommand("/repo/editors/vscode", "", {
    ...NOTHING,
    exists: () => true,
    nodeVersion: () => "v22.18.0",
  });
  assert.deepEqual(found.args, ["--conditions=development", "/repo/packages/lsp/src/main.ts", "--stdio"]);
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

// ------------------------------------------------------------- what gets packaged

test("the bundle retargets the one bare specifier, per file and not per prefix", () => {
  // `@sqldex/core` is what a node_modules would have answered, and the bundle deliberately is not
  // one — Node refuses to strip types under `node_modules`. So the import is rewritten, and how far
  // up it has to reach depends on how deep the file sits. `syntax-antlr` gets the same treatment,
  // and is checked here too: its own source imports `@sqldex/core` the same way `lsp`'s does.
  const repo = tree(
    "packages/core/src",
    "packages/syntax-antlr/src",
    "packages/lsp/src/features",
    "editors/vscode",
  );
  writeFileSync(join(repo, "packages/core/package.json"), "{}");
  writeFileSync(join(repo, "packages/syntax-antlr/package.json"), "{}");
  writeFileSync(join(repo, "packages/lsp/package.json"), "{}");
  writeFileSync(join(repo, "packages/core/src/index.ts"), "export const marker = 1;\n");
  writeFileSync(
    join(repo, "packages/syntax-antlr/src/index.ts"),
    'import { marker } from "@sqldex/core";\n',
  );
  writeFileSync(join(repo, "packages/lsp/src/main.ts"), 'import { marker } from "@sqldex/core";\n');
  writeFileSync(
    join(repo, "packages/lsp/src/features/hover.ts"),
    'import { marker } from "@sqldex/core";\n',
  );

  const main = bundle(join(repo, "editors", "vscode"));
  assert.equal(main, join(repo, "editors/vscode/server/lsp/src/main.ts"));
  assert.match(readFileSync(main, "utf8"), /from "\.\.\/\.\.\/core\/src\/index\.ts"/);
  assert.match(
    readFileSync(join(repo, "editors/vscode/server/lsp/src/features/hover.ts"), "utf8"),
    /from "\.\.\/\.\.\/\.\.\/core\/src\/index\.ts"/,
  );
  assert.match(
    readFileSync(join(repo, "editors/vscode/server/syntax-antlr/src/index.ts"), "utf8"),
    /from "\.\.\/\.\.\/core\/src\/index\.ts"/,
  );

  // Nothing under a directory called node_modules, which is the whole point of the layout.
  assert.equal(existsSync(join(repo, "editors/vscode/server/node_modules")), false);
});

test("bundling twice leaves no trace of the first time", () => {
  const repo = tree("packages/core/src", "packages/syntax-antlr/src", "packages/lsp/src", "editors/vscode");
  writeFileSync(join(repo, "packages/core/package.json"), "{}");
  writeFileSync(join(repo, "packages/syntax-antlr/package.json"), "{}");
  writeFileSync(join(repo, "packages/lsp/package.json"), "{}");
  writeFileSync(join(repo, "packages/core/src/index.ts"), "");
  writeFileSync(join(repo, "packages/syntax-antlr/src/index.ts"), "");
  writeFileSync(join(repo, "packages/lsp/src/main.ts"), "");

  bundle(join(repo, "editors", "vscode"));
  const stale = join(repo, "editors/vscode/server/lsp/src/gone.ts");
  writeFileSync(stale, "");
  bundle(join(repo, "editors", "vscode"));

  // A file from a previous version surviving into the package is wrong in a way nobody could
  // reproduce from the repository, so the directory is rebuilt rather than patched.
  assert.equal(existsSync(stale), false);
});
