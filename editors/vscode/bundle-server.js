/**
 * Puts the server inside the extension, which is what makes a `.vsix` worth handing to somebody.
 *
 * A packaged extension has no checkout to fall back on and no reason to expect `sqldex-lsp` on the
 * machine it lands on, so an extension that only knew how to find a server somebody else installed
 * would be one that does nothing when installed. This copies the two source packages into the
 * extension's own `server/`:
 *
 *     server/lsp/src/main.ts     what gets run
 *     server/core/               what it imports
 *
 * **Not into a `node_modules`**, which is the one thing here that is not obvious and was found by
 * trying it: Node refuses to strip types from a file under `node_modules`, so a copy laid out the
 * way an installed dependency would be is a copy that will not start —
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, at the first import, with the whole server dead
 * behind it.
 *
 * That is also why the one bare specifier the server uses — `@sqldex/core`, the thing a node_modules
 * would have answered — is retargeted to a relative path on the way in. It is a rewrite of the
 * import and nothing else: no compiler, no bundler, no emitted JavaScript. What ships is the source
 * in `packages/`, which is what the checkout runs too.
 *
 * The protocol libraries are not copied at all. Node walks *up* from the file it is resolving, so
 * `vscode-languageserver` is found in the extension's own `node_modules` — where it is a declared
 * dependency for exactly this reason, and where the client's half of the same libraries already
 * lives. One copy in the package rather than two.
 *
 *     node bundle-server.js
 */

"use strict";

const { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

/** Where the server lands, relative to the extension. Both halves of the client agree on this. */
const BUNDLE = "server";

/** The specifier a `node_modules` would have answered, and what it points at once copied. */
const SPECIFIER = "@sqldex/core";
const CORE_ENTRY = "core/src/index.ts";

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
 * Points `@sqldex/core` at the copy beside it.
 *
 * Per file, because the answer depends on how deep the file sits: `server/lsp/src/server.ts` and
 * `server/lsp/src/features/hover.ts` are different numbers of directories away from the same entry
 * point, and one hard-coded prefix would be right for the first and silently wrong for the second.
 */
function retarget(file, root) {
  const source = readFileSync(file, "utf8");
  if (!source.includes(`"${SPECIFIER}"`)) return;

  let path = relative(dirname(file), join(root, CORE_ENTRY)).replaceAll("\\", "/");
  if (!path.startsWith(".")) path = `./${path}`;
  writeFileSync(file, source.replaceAll(`"${SPECIFIER}"`, `"${path}"`));
}

function bundle(extensionPath) {
  const checkout = resolve(extensionPath, "..", "..");
  const root = join(extensionPath, BUNDLE);

  // Wholesale, never patched: a stale file left over from a previous version is the one thing that
  // would be invisible in the packaged extension and wrong in a way nobody could reproduce.
  rmSync(root, { recursive: true, force: true });

  for (const name of ["core", "lsp"]) {
    mkdirSync(join(root, name), { recursive: true });
    // The manifest and the source, which is everything one of these packages needs to run.
    for (const part of ["package.json", "src"]) {
      cpSync(join(checkout, "packages", name, part), join(root, name, part), { recursive: true });
    }
  }

  for (const file of sources(join(root, "lsp", "src"))) retarget(file, root);
  return join(root, "lsp", "src", "main.ts");
}

module.exports = { BUNDLE, bundle };

if (require.main === module) {
  const main = bundle(__dirname);
  console.log(`bundled: ${main}`);
}
