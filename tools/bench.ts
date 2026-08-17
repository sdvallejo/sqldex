/**
 * Lexer throughput over a directory of SQL.
 *
 *     node tools/bench.ts <dir>...
 *
 * Files are read into memory first and the timer covers `tokenize` alone. Indexing a repo is
 * dominated by scanning bytes, and that is the number worth watching for regressions; folding in
 * the filesystem would measure the disk instead, and it varies far more than the code does.
 *
 * Reports the best of five runs and the median. The best run is the one to compare across
 * changes — it is the one least polluted by whatever else the machine was doing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { tokenize } from "../packages/core/src/syntax/fast/lexer.ts";

const RUNS = 5;

/** Every `.sql` under a directory, sorted, absolute. */
function sqlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".sql")) out.push(path);
    }
  };
  walk(root);
  out.sort();
  return out;
}

function bench(root: string): void {
  const sources = sqlFiles(root).map((p) => readFileSync(p, "utf8"));
  const units = sources.reduce((n, s) => n + s.length, 0);

  const times: number[] = [];
  let tokens = 0;
  for (let run = 0; run < RUNS; run++) {
    tokens = 0;
    const started = performance.now();
    for (const src of sources) tokens += tokenize(src).tokens.length;
    times.push(performance.now() - started);
  }

  times.sort((a, b) => a - b);
  const best = times[0]!;
  const median = times[RUNS >> 1]!;
  console.log(
    `${basename(root).padEnd(12)} ${String(sources.length).padStart(5)} files  ` +
      `${(units / 1e6).toFixed(1).padStart(5)} MB  ${String(tokens).padStart(9)} tokens  ` +
      `best ${best.toFixed(0).padStart(5)} ms  median ${median.toFixed(0).padStart(5)} ms  ` +
      `${(units / 1e6 / (best / 1000)).toFixed(1).padStart(5)} MB/s`,
  );
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/bench.ts <dir>...");
  process.exit(2);
}
for (const root of roots) bench(root);
