/**
 * One shard of the batch syntax check, run to completion, then reported back.
 *
 * A whole shard rather than one file per worker: spawning a worker and loading the vendored MySQL
 * grammar into it has its own fixed cost, measured as tens of milliseconds — worth paying once per
 * core, not once per file.
 */

import { workerData } from "node:worker_threads";
import { checkSyntax } from "@sqldex/syntax-antlr";
import type { SyntaxError } from "@sqldex/syntax-antlr";
import type { ShardMessage, ShardResult, WorkerData } from "./syntax-pool.ts";

const { jobs, index, doneFlags, resultPort } = workerData as WorkerData;

try {
  const results: ShardResult[] = jobs.map((job) => ({ path: job.path, errors: checkSyntax(job.src) }));
  const message: ShardMessage = { ok: true, results };
  resultPort.postMessage(message);
} catch (error) {
  // `checkSyntax` itself has no `throw` in its normal error-recovery path — this is a genuine
  // surprise, not the shape a malformed file takes, and the pool reports it as a warning rather than
  // hang the run waiting for a shard that will never post its flag.
  const message: ShardMessage = { ok: false, error: error instanceof Error ? error.message : String(error) };
  resultPort.postMessage(message);
} finally {
  Atomics.store(doneFlags, index, 1);
  Atomics.notify(doneFlags, index);
}
