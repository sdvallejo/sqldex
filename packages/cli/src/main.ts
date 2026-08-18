#!/usr/bin/env node
/**
 * The `sqldex` command.
 *
 * Argument parsing is `node:util`'s `parseArgs`, which is the built-in answer to "a CLI with no
 * dependencies" — the same property the engine holds, and the reason this package has an empty
 * `dependencies` beside `@sqldex/core`.
 *
 * ## `--diff` always takes a value
 *
 * `--diff origin/master` and `--diff auto` — never a bare `--diff`. An optional value would make
 * `sqldex check --diff tables/` ambiguous between "diff against `tables/`" and "diff against the
 * environment, and lint `tables/`", and a CLI that resolves that by guessing is one that silently
 * lints the wrong thing in somebody's pipeline. `auto` reads the base out of the CI job.
 *
 * ## Exit codes
 *
 *   - **0** — nothing above the failure floor.
 *   - **1** — findings above it: any `error`, or more warnings than `--max-warnings` allows.
 *   - **2** — the command could not run: bad usage, no such rule, git could not diff.
 *
 * A `hint` never fails a build. It is the severity for things worth knowing and not worth
 * stopping for, and a level that can fail a build is not that.
 */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { allRules, type Registry } from "@sqldex/core";

import { baseFrom, changedFiles, DiffError } from "./changed.ts";
import { github } from "./format/github.ts";
import { gitlab } from "./format/gitlab.ts";
import { json } from "./format/json.ts";
import { noColor, paintFor, pretty } from "./format/pretty.ts";
import { sarif } from "./format/sarif.ts";
import { explain, listRules } from "./rules.ts";
import { rootFor, run, type Report } from "./run.ts";

const FORMATS = ["pretty", "json", "sarif", "github", "gitlab"] as const;
type Format = (typeof FORMATS)[number];

const USAGE = `sqldex — static analysis for MySQL schemas kept as .sql files

  sqldex check [paths...]        check the project, or just the paths named
  sqldex rules                   every rule, with a one-line summary
  sqldex explain <rule-id>       the full reasoning behind one rule

Options for check:
  --format <name>       pretty (default), json, sarif, github, gitlab
  --diff <base|auto>    only files changed since <base>; auto reads it from the CI job
  --quiet               drop hints, keeping warnings and errors
  --max-warnings <n>    exit 1 once there are more warnings than n
  --no-color            never colour the output (NO_COLOR does the same)

Options for rules:
  --format <name>       pretty (default) or json

  --help, --version

Exit codes: 0 clean, 1 findings above the failure floor, 2 the command could not run.`;

const CONFIG: ParseArgsConfig = {
  allowPositionals: true,
  strict: true,
  options: {
    format: { type: "string" },
    diff: { type: "string" },
    quiet: { type: "boolean" },
    "max-warnings": { type: "string" },
    "no-color": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
  },
};

/**
 * `no-color` is declared outright rather than as the negation of a `color` flag: `parseArgs` has no
 * notion of `--no-` prefixes, and a flag it does not know about is a usage error, not a default.
 */
interface Flags {
  format?: string;
  diff?: string;
  quiet?: boolean;
  "max-warnings"?: string;
  "no-color"?: boolean;
  help?: boolean;
  version?: boolean;
}

export interface Streams {
  out(text: string): void;
  err(text: string): void;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
}

function version(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    if (typeof raw === "object" && raw !== null && "version" in raw) return String(raw.version);
  } catch {
    // A package with no readable manifest is odd but not a reason to refuse to run.
  }
  return "0.0.0";
}

function render(
  report: Report,
  format: Format,
  registry: Registry,
  streams: Streams,
  colored: boolean,
): string {
  switch (format) {
    case "json":
      return json(report);
    case "sarif":
      // The registry that ran, not a fresh one: SARIF's rule array is what its results index into,
      // and describing a different set of rules than the run used is how that index goes wrong.
      return sarif(report, registry.all(), version());
    case "github":
      return github(report);
    case "gitlab":
      return gitlab(report);
    case "pretty":
      return pretty(report, colored ? paintFor(streams.isTTY, streams.env) : noColor);
  }
}

/** Narrows a string to a format, which is where an unknown one has to be caught. */
function asFormat(name: string): Format | undefined {
  return FORMATS.find((known) => known === name);
}

function doCheck(positionals: readonly string[], flags: Flags, streams: Streams): number {
  const format = asFormat(flags.format ?? "pretty");
  if (format === undefined) {
    streams.err(`unknown format: ${flags.format} (${FORMATS.join(", ")})`);
    return 2;
  }

  let maxWarnings = Infinity;
  if (flags["max-warnings"] !== undefined) {
    maxWarnings = Number(flags["max-warnings"]);
    if (!Number.isInteger(maxWarnings) || maxWarnings < 0) {
      streams.err(`--max-warnings wants a whole number, got: ${flags["max-warnings"]}`);
      return 2;
    }
  }

  const registry = allRules();
  let only: Set<string> | undefined;
  if (flags.diff !== undefined) {
    try {
      const base = baseFrom(flags.diff === "auto" ? undefined : flags.diff, streams.env);
      // Git has to be asked from the root, and it is found the same way `run` finds it — the two
      // must agree, or the paths git returns are resolved against a directory the sweep never saw.
      only = new Set(changedFiles(rootFor(positionals, streams.cwd), base));
    } catch (error) {
      streams.err(error instanceof DiffError ? error.message : String(error));
      return 2;
    }
  }

  const report = run({ paths: positionals, only, registry, cwd: streams.cwd, onWarning: streams.err });
  if (flags.quiet) {
    // Dropped from the report entirely, counts included, rather than merely hidden: a summary
    // counting hints under output that shows none is a report about a different run.
    report.findings = report.findings.filter((f) => f.diagnostic.severity !== "hint");
    report.counts.hint = 0;
  }

  streams.out(render(report, format, registry, streams, flags["no-color"] !== true));
  return report.counts.error > 0 || report.counts.warn > maxWarnings ? 1 : 0;
}

export function main(argv: readonly string[], streams: Streams): number {
  let parsed;
  try {
    parsed = parseArgs({ ...CONFIG, args: [...argv] });
  } catch (error) {
    streams.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const flags = parsed.values as Flags;
  const [command, ...rest] = parsed.positionals;

  if (flags.version) {
    streams.out(version());
    return 0;
  }
  if (flags.help || command === undefined || command === "help") {
    streams.out(USAGE);
    return command === undefined && !flags.help ? 2 : 0;
  }

  switch (command) {
    case "check":
      return doCheck(rest, flags, streams);
    case "rules": {
      const format = flags.format ?? "pretty";
      if (format !== "pretty" && format !== "json") {
        streams.err(`unknown format for rules: ${format} (pretty, json)`);
        return 2;
      }
      streams.out(listRules(allRules(), format));
      return 0;
    }
    case "explain": {
      const id = rest[0];
      if (id === undefined) {
        streams.err("explain wants a rule id, as in: sqldex explain query/unfiltered-write");
        return 2;
      }
      const { text, found } = explain(allRules(), id);
      if (found) streams.out(text);
      else streams.err(text);
      return found ? 0 : 2;
    }
    default:
      streams.err(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Was this file run as the program, rather than imported by a test?
 *
 * Through `realpath`, because npm installs a `bin` as a symlink: `argv[1]` is then
 * `node_modules/.bin/sqldex` while `import.meta.filename` is the file it points at, and comparing
 * the two as written makes the installed command do nothing at all.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === import.meta.filename;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
    err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
    cwd: process.cwd(),
  });
}
