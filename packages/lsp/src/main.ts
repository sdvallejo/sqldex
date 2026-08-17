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
 */

import { createConnection } from "vscode-languageserver/node";

import { createServer } from "./server.ts";

createServer(createConnection());
