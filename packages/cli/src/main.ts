#!/usr/bin/env node
/**
 * The entry point `bin` names — a shim, on purpose, so a Node too old to run `sqldex` learns why.
 *
 * `cli.ts` is where the command actually lives. It is not imported here until *after* the version
 * check below, because `cli.ts` imports `@sqldex/core`, which reads the project off disk with
 * `node:fs`'s `globSync` — added in Node 22 — and an ES module's static imports evaluate before its
 * importer's own top-level code runs, no matter where the `import` line sits in the file. Importing
 * `cli.ts` at the top of this one, the way a file normally would, means the crash happens during
 * that import, before this file's own check ever gets to run: a `SyntaxError` naming a function
 * nobody asked about, instead of a sentence that names the actual cause. The dynamic `import()`
 * below is what defers it far enough to matter.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nodeTooOld } from "./node-check.ts";

/**
 * Was this file run as the program, rather than imported by a test?
 *
 * Through `realpath`, because npm installs a `bin` as a symlink: `argv[1]` is then
 * `node_modules/.bin/sqldex` while this file's own path is the one the symlink points at, and
 * comparing the two as written makes the installed command do nothing at all.
 *
 * `fileURLToPath(import.meta.url)` rather than `import.meta.filename`: the latter is `undefined` on
 * a Node old enough that this file is precisely where that needs saying, so relying on it here would
 * make an old Node run silently do nothing at all instead of reaching the version check below.
 * `import.meta.url` has no such floor.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const problem = nodeTooOld(process.version);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }

  const { main } = await import("./cli.ts");
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
    err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
  });
}
