#!/usr/bin/env node
/**
 * The `sqldex-lsp` command: a language server on stdio.
 *
 * It takes no arguments of its own. Which project it serves comes from the `initialize` request, and
 * how it is configured comes from the `.sqldex.json` in that project — the same file the command
 * reads, because a rule that is off in CI and on in the editor is a rule nobody trusts.
 *
 * `createConnection` with no arguments reads the transport out of `process.argv`, which is what
 * every client already knows how to pass: `--stdio`, `--node-ipc`, `--socket=<port>`. Nothing here
 * needs to be told which one was chosen.
 *
 * ## Why the other imports are dynamic
 *
 * `./server.ts` imports `@sqldex/core`, which reads the project off disk with `node:fs`'s
 * `globSync` — added in Node 22 — and an ES module's static imports evaluate before its importer's
 * own top-level code runs, no matter where the `import` line sits in the file. A static import of
 * `./server.ts` at the top of this one would crash during that import, before the version check
 * below ever ran: a `SyntaxError` naming a function nobody asked about, on `stdio` with no terminal
 * to show it, instead of a sentence the client's own log can show. The dynamic `import()`s below are
 * what defer it far enough to matter.
 */

import { nodeTooOld } from "./node-check.ts";

const problem = nodeTooOld(process.version);
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}

const [{ createConnection }, { createServer }] = await Promise.all([
  import("vscode-languageserver/node"),
  import("./server.ts"),
]);

createServer(createConnection());
