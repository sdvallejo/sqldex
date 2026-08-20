/**
 * The syntax check's own thread.
 *
 * Measured against real files from the private corpora: a real production routine (44.7 KB) costs
 * ~500ms to parse against the real MySQL grammar — not a tail case, what a realistic file costs. Run
 * on the server's own thread that would stall every other request (hover, completion, another
 * document's diagnostics) for half a second on every edit to a file that size. This is the whole
 * reason this file exists rather than a function call inside `server.ts`.
 */

import { parentPort } from "node:worker_threads";
import { checkSyntax } from "@sqldex/syntax-antlr";
import type { SyntaxError } from "@sqldex/syntax-antlr";

export interface SyntaxRequest {
  uri: string;
  seq: number;
  src: string;
}

export interface SyntaxResponse {
  uri: string;
  seq: number;
  errors: SyntaxError[];
}

if (!parentPort) throw new Error("syntax-worker.ts must be run as a worker_threads Worker");

parentPort.on("message", (request: SyntaxRequest) => {
  const errors = checkSyntax(request.src);
  const response: SyntaxResponse = { uri: request.uri, seq: request.seq, errors };
  parentPort!.postMessage(response);
});
