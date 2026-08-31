/**
 * How to start the server, and how to say why when it cannot be started.
 *
 * Four ways of finding it, in the order of how much somebody meant them:
 *
 *   1. `sqldex.server.path`, which is a person naming a file;
 *   2. `sqldex-lsp` on the `PATH`, which is a person having installed one;
 *   3. the checkout this extension sits in, which is a person having cloned the repository and
 *      opened `editors/vscode` from it. Only a checkout whose dependencies are installed: the
 *      protocol library is the one thing the server cannot do without;
 *   4. the copy inside the extension itself, which is what a packaged `.vsix` carries and the only
 *      one that is there on a machine that has never seen this repository.
 *
 * The checkout comes before the bundled copy on purpose, and only that pair needed thinking about:
 * the bundle is a copy *taken from* the checkout, so anybody who has both is working on the server
 * and means to run what they just edited. On an installed extension there is no checkout above it
 * and the question never arises.
 *
 * When none of them is there the installed name comes back anyway, so what a person sees is the
 * client's own "command not found" rather than a message invented here about a file it never tried.
 *
 * Nothing in this file touches the editor API, which is what lets it be tested without one.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const { BUNDLE } = require("./bundle-server.js");

/** Node the server needs, which is the version that runs TypeScript without a build step. */
const NEEDS_NODE = { major: 22, minor: 18 };

/** The checkout `editors/vscode` sits in, or wherever it was copied to. */
function checkoutOf(extensionPath) {
  return resolve(extensionPath, "..", "..");
}

function onPath(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function nodeVersion() {
  try {
    return execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Is `version` — `v22.18.0` as `node --version` prints it — new enough? */
function isRecentEnough(version) {
  const parts = /^v(\d+)\.(\d+)/.exec(version ?? "");
  if (!parts) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  return major > NEEDS_NODE.major || (major === NEEDS_NODE.major && minor >= NEEDS_NODE.minor);
}

/**
 * What to run, why, and what is wrong with it if anything is.
 *
 * `problem` is filled in only where the command will start and then not work — a checkout on a Node
 * too old to read the server's own source. It is a sentence for the output channel, not a thrown
 * error: the extension still tries, because being told what happened beats being told nothing.
 *
 * @returns {{ command: string, args: string[], why: string, problem?: string }}
 */
function serverCommand(extensionPath, configured, probes = {}) {
  const exists = probes.exists ?? existsSync;
  const installed = probes.onPath ?? onPath;
  const version = probes.nodeVersion ?? nodeVersion;

  const named = (configured ?? "").trim();
  if (named) return { command: named, args: ["--stdio"], why: "sqldex.server.path names it" };

  if (installed("sqldex-lsp")) return { command: "sqldex-lsp", args: ["--stdio"], why: "sqldex-lsp is on the PATH" };

  const root = checkoutOf(extensionPath);
  const checkout = join(root, "packages", "lsp", "src", "main.ts");
  if (exists(checkout) && exists(join(root, "node_modules", "vscode-languageserver"))) {
    return sourced(checkout, `the checkout at ${root}`, version);
  }

  const bundled = join(extensionPath, BUNDLE, "lsp", "src", "main.ts");
  if (exists(bundled)) return sourced(bundled, "the copy this extension was packaged with", version);

  return {
    command: "sqldex-lsp",
    args: ["--stdio"],
    why: "nothing was found, so this is the client's own error to report",
  };
}

/**
 * Running the server from its source, which is what both the checkout and the bundle are.
 *
 * The Node check belongs here rather than at either call site: what it is really testing is whether
 * the `node` on this machine reads TypeScript, and the answer does not depend on which copy of the
 * source is about to be handed to it.
 */
function sourced(main, why, version) {
  const found = version();
  const problem = isRecentEnough(found)
    ? undefined
    : `needs node ${NEEDS_NODE.major}.${NEEDS_NODE.minor} or newer to run the server from source — ` +
      `${found ?? "no node"} was found on the PATH.`;
  // `--conditions=development` is what makes `@sqldex/core` resolve to the checkout's **source**.
  // Without it the package's `exports` answer with the built `dist/`, which a checkout is not
  // required to have: the repository is developed and tested without a build, and building only
  // for an editor to start would be a build step by the back door.
  return { command: "node", args: ["--conditions=development", main, "--stdio"], why, problem };
}

module.exports = { NEEDS_NODE, checkoutOf, isRecentEnough, serverCommand };
