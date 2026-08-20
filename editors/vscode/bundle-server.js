/**
 * Puts the server inside the extension, which is what makes a `.vsix` worth handing to somebody.
 *
 * A packaged extension has no checkout to fall back on and no reason to expect `sqldex-lsp` on the
 * machine it lands on, so an extension that only knew how to find a server somebody else installed
 * would be one that does nothing when installed. This copies the workspace packages the server needs
 * into the extension's own `server/`:
 *
 *     server/lsp/src/main.ts       what gets run
 *     server/core/                 what it imports
 *     server/syntax-antlr/         what it imports for the real MySQL grammar
 *
 * **Not into a `node_modules`**, which is the one thing here that is not obvious and was found by
 * trying it: Node refuses to strip types from a file under `node_modules`, so a copy laid out the
 * way an installed dependency would be is a copy that will not start —
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, at the first import, with the whole server dead
 * behind it.
 *
 * That is also why the bare specifiers the server uses for its own workspace packages —
 * `@sqldex/core` and `@sqldex/syntax-antlr`, the things a `node_modules` would have answered — are
 * retargeted to a relative path on the way in, in *every* copied package's own source, not just
 * `lsp`'s: `syntax-antlr` itself imports `@sqldex/core` too. It is a rewrite of the import and
 * nothing else: no compiler, no bundler, no emitted JavaScript. What ships is the source in
 * `packages/`, which is what the checkout runs too.
 *
 * The protocol libraries, and `antlr4ng`, are not copied at all. Node walks *up* from the file it is
 * resolving, so they are found in the extension's own `node_modules` — where each is a declared
 * dependency for exactly this reason. `vscode-languageserver` is there because the client's half of
 * the same libraries already lives there too; `antlr4ng` is there because it is a real published
 * package with nothing workspace-local about it, unlike `@sqldex/core`/`@sqldex/syntax-antlr`. One
 * copy in the package rather than two.
 *
 *     node bundle-server.js
 */

"use strict";

const { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

/** Where the server lands, relative to the extension. Both halves of the client agree on this. */
const BUNDLE = "server";

/** Workspace packages the server needs, copied whole, and the specifier/entry each is retargeted to. */
const PACKAGES = [
  { name: "core", specifier: "@sqldex/core", entry: "core/src/index.ts" },
  { name: "syntax-antlr", specifier: "@sqldex/syntax-antlr", entry: "syntax-antlr/src/index.ts" },
  { name: "lsp", specifier: undefined, entry: undefined },
];

/** Every `.ts` file below a directory. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Points every workspace-package specifier a file uses at the copy beside it.
 *
 * Per file, because the answer depends on how deep the file sits: `server/lsp/src/server.ts` and
 * `server/lsp/src/features/hover.ts` are different numbers of directories away from the same entry
 * point, and one hard-coded prefix would be right for the first and silently wrong for the second.
 */
function retarget(file, root) {
  let source = readFileSync(file, "utf8");
  let changed = false;

  for (const target of PACKAGES) {
    if (!target.specifier || !source.includes(`"${target.specifier}"`)) continue;
    let path = relative(dirname(file), join(root, target.entry)).replaceAll("\\", "/");
    if (!path.startsWith(".")) path = `./${path}`;
    source = source.replaceAll(`"${target.specifier}"`, `"${path}"`);
    changed = true;
  }

  if (changed) writeFileSync(file, source);
}

function bundle(extensionPath) {
  const checkout = resolve(extensionPath, "..", "..");
  const root = join(extensionPath, BUNDLE);

  // Wholesale, never patched: a stale file left over from a previous version is the one thing that
  // would be invisible in the packaged extension and wrong in a way nobody could reproduce.
  rmSync(root, { recursive: true, force: true });

  for (const { name } of PACKAGES) {
    mkdirSync(join(root, name), { recursive: true });
    // The manifest and the source, which is everything one of these packages needs to run.
    for (const part of ["package.json", "src"]) {
      cpSync(join(checkout, "packages", name, part), join(root, name, part), { recursive: true });
    }
  }

  // Every copied package's own source can use another workspace package's specifier — `syntax-antlr`
  // imports `@sqldex/core`, not just `lsp` — so every one of them gets retargeted, not only `lsp`'s.
  for (const { name } of PACKAGES) {
    for (const file of sources(join(root, name, "src"))) retarget(file, root);
  }
  return join(root, "lsp", "src", "main.ts");
}

module.exports = { BUNDLE, bundle };

if (require.main === module) {
  const main = bundle(__dirname);
  console.log(`bundled: ${main}`);
}
