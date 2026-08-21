/**
 * Runs `checkSyntax` for a whole batch of files across a pool of worker threads, blocking the
 * caller until every shard has reported back.
 *
 * `run()` (`run.ts`) is synchronous top to bottom, deliberately: making it async would cascade
 * through `main()`'s one production call site and every test in `cli.test.ts`'s `cli()` helper, for
 * a command that is a one-shot process, not a long-lived server. `Atomics.wait` below blocks only
 * the thread that calls it — the workers it is waiting on run on their own OS threads regardless, so
 * this is real parallelism, not sequential work wearing a synchronous face. Verified directly before
 * building this: four workers each doing 400ms of synchronous CPU work finished in ~430ms wall
 * time, not ~1600ms. This is the same technique packages like `synckit` use to give a synchronous
 * API a parallel engine underneath — built here instead of taken as a dependency, matching this
 * package's existing zero-extra-dependencies stance.
 *
 * `MessageChannel` + `receiveMessageOnPort` carries each shard's results, because `Atomics.wait`
 * only synchronizes on integers in a `SharedArrayBuffer` — it has nothing to say about the error
 * arrays themselves. `receiveMessageOnPort` drains a port's already-queued message without needing
 * the event loop to run, which is what makes it safe to call right after `Atomics.wait` wakes on a
 * thread that never started that loop back up.
 */

import { availableParallelism } from "node:os";
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import type { SyntaxError } from "@sqldex/syntax-antlr";

export interface SyntaxJob {
  path: string;
  src: string;
}

export interface ShardResult {
  path: string;
  errors: SyntaxError[];
}

export type ShardMessage = { ok: true; results: ShardResult[] } | { ok: false; error: string };

export interface WorkerData {
  jobs: SyntaxJob[];
  index: number;
  doneFlags: Int32Array;
  resultPort: MessagePort;
}

/** Running from source, as a checkout does, rather than from a package's own compiled `dist/`. */
function isDevelopment(): boolean {
  return import.meta.url.endsWith(".ts");
}

/**
 * Splits `jobs` round-robin across `parts` shards, not into contiguous chunks — parse cost tracks a
 * file's structural complexity, not its byte count (measured on the real corpora this package is
 * tested against: a 324 KB single-statement file parses about as fast as a 45 KB one), so a
 * contiguous slice is exactly the layout most likely to hand one worker every expensive file in the
 * project and another none of them. Files are typically swept in an OS-listing order that has no
 * relationship to cost, so round-robin over that order is already a reasonable balance.
 */
function shard<T>(jobs: readonly T[], parts: number): T[][] {
  const out: T[][] = Array.from({ length: parts }, () => []);
  jobs.forEach((job, i) => out[i % parts]!.push(job));
  return out;
}

/** Every job's syntax errors, run in parallel, keyed by the job's own `path`. */
export function checkSyntaxBatch(
  jobs: readonly SyntaxJob[],
  onWarning?: (message: string) => void,
): Map<string, SyntaxError[]> {
  const out = new Map<string, SyntaxError[]>();
  if (jobs.length === 0) return out;

  const poolSize = Math.max(1, Math.min(availableParallelism(), jobs.length));
  const shards = shard(jobs, poolSize);
  const doneFlags = new Int32Array(new SharedArrayBuffer(poolSize * Int32Array.BYTES_PER_ELEMENT));
  const execArgv = isDevelopment() ? ["--conditions=development"] : [];

  const workers = shards.map((shardJobs, index) => {
    const { port1, port2 } = new MessageChannel();
    const workerData: WorkerData = { jobs: shardJobs, index, doneFlags, resultPort: port2 };
    const worker = new Worker(new URL("./syntax-worker.ts", import.meta.url), {
      execArgv,
      workerData,
      transferList: [port2],
    });
    worker.unref();
    // A worker that fails to even start (as opposed to `checkSyntax` throwing, caught inside it)
    // never reaches the `finally` that flips its flag — without this, that shard hangs the run
    // forever instead of losing just its own files' syntax findings.
    worker.on("error", (error: Error) => {
      onWarning?.(`syntax check worker failed: ${error.message}`);
      Atomics.store(doneFlags, index, 1);
      Atomics.notify(doneFlags, index);
    });
    return { worker, port1, index };
  });

  for (const { worker, port1, index } of workers) {
    Atomics.wait(doneFlags, index, 0);
    const received = receiveMessageOnPort(port1);
    const message = received?.message as ShardMessage | undefined;
    if (message === undefined) {
      // The worker's own `error` handler above flipped the flag with nothing posted to the port.
    } else if (message.ok) {
      for (const result of message.results) out.set(result.path, result.errors);
    } else {
      onWarning?.(`syntax check worker failed: ${message.error}`);
    }
    port1.close();
    void worker.terminate();
  }

  return out;
}
