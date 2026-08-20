/**
 * The main thread's half of the syntax check: spawns the worker lazily, and decides which of its
 * answers still matter.
 *
 * A response is stale, and dropped, whenever a newer request for the same document has been made
 * since — which is also, by construction, whenever the document's text has moved on: nothing calls
 * `request` without the document having just changed. Keeping only the latest means a burst of edits
 * costs the worker some wasted parses, never a wrong answer shown.
 */

import { Worker } from "node:worker_threads";
import type { SyntaxRequest, SyntaxResponse } from "./syntax-worker.ts";

export type { SyntaxResponse } from "./syntax-worker.ts";

/** Running from source, as a checkout does, rather than from a package's own compiled `dist/`. */
function isDevelopment(): boolean {
  return import.meta.url.endsWith(".ts");
}

export class SyntaxChecker {
  private worker: Worker | undefined;
  private readonly latestSeq = new Map<string, number>();
  private readonly onResult: (response: SyntaxResponse) => void;

  constructor(onResult: (response: SyntaxResponse) => void) {
    this.onResult = onResult;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // A worker starts with a bare `process.execArgv`, not this one's — so a checkout run, which
    // resolves `@sqldex/syntax-antlr` via the `development` custom condition, has to say so again
    // explicitly here or the worker falls back to `dist/`, which a plain checkout never built.
    // Forwarding the whole of `process.execArgv` was tried first and is wrong: under `node --test`
    // it carries internal flags (`--stack-trace-limit`, TLS cipher lists, V8 snapshot flags…) that
    // are not valid to hand to a fresh `Worker`. Only the one condition this actually depends on.
    const execArgv = isDevelopment() ? ["--conditions=development"] : [];
    const worker = new Worker(new URL("./syntax-worker.ts", import.meta.url), { execArgv });
    worker.on("message", (response: SyntaxResponse) => {
      if (this.latestSeq.get(response.uri) !== response.seq) return;
      this.onResult(response);
    });
    // A worker that fails to start or crashes mid-parse should not take the rest of the server down
    // with it — every other feature is unaffected by this one going quiet, and the next `request`
    // respawns it.
    worker.on("error", () => {
      this.worker = undefined;
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  request(uri: string, src: string): void {
    const seq = (this.latestSeq.get(uri) ?? 0) + 1;
    this.latestSeq.set(uri, seq);
    const request: SyntaxRequest = { uri, seq, src };
    this.ensureWorker().postMessage(request);
  }

  /** A closed document's next response, if one is still in flight, is nobody's business. */
  forget(uri: string): void {
    this.latestSeq.delete(uri);
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
    this.latestSeq.clear();
  }
}
