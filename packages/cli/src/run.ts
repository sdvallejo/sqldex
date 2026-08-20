/**
 * One `sqldex check` run: find the project, build the catalog, sweep the files.
 *
 * Kept apart from `main.ts` so that what the command *does* can be tested without going through
 * argument parsing and process exit codes, and so the formats below have one shape to render
 * rather than a catalog and a diagnostic each.
 */

import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  Catalog,
  check,
  findRoot,
  get,
  lineCol,
  lineIndex,
  mysql,
  schemas as configuredSchemas,
  targetFiles,
  tokenize,
  withOwnDefinitions,
  type Diagnostic,
  type FileRef,
  type Position,
  type Registry,
  type Severity,
} from "@sqldex/core";
import { checkSyntax, toDiagnostics } from "@sqldex/syntax-antlr";

/** A diagnostic, placed: which file, and where in it in the terms a person and a CI service use. */
export interface Finding {
  /** Relative to the project root, with `/` separators, which is what every consumer keys on. */
  path: string;
  /** Absolute, for anything that has to open the file again. */
  absolute: string;
  diagnostic: Diagnostic;
  /** 0-based, as everywhere in the engine. The formats that want 1-based convert in the open. */
  start: Position;
  end: Position;
}

export interface Report {
  root: string;
  findings: Finding[];
  /** How many files were linted, and how many the catalog was built from. */
  linted: number;
  indexed: number;
  ms: number;
  counts: Record<Severity, number>;
}

export interface RunOptions {
  /** Files or directories named on the command line. Empty = the whole project. */
  paths: readonly string[];
  /** Restricts the sweep to these absolute paths. `undefined` = no restriction. */
  only?: ReadonlySet<string>;
  registry: Registry;
  cwd: string;
  /**
   * Where a complaint about the project file goes.
   *
   * Not a finding: a key nothing reads is not a defect in the SQL, and burying it among them would
   * make it a line in a list nobody counts. It belongs where the invocation's own problems go.
   */
  onWarning?: (message: string) => void;
}

/** POSIX-separated and root-relative, so a report reads the same on either platform. */
function display(root: string, path: string): string {
  const rel = relative(root, path);
  return (rel === "" ? path : rel).split(sep).join("/");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project root for this invocation.
 *
 * **The `isDdlProject` guard is deliberately not applied.** That guard exists so an editor does not
 * start indexing every repo with a stray `.sql` in it — it is about implicit activation, and
 * `sqldex check .` is not implicit. Running the command *is* the declaration of intent, so a flat
 * directory with no recognised layout has to work.
 */
export function rootFor(paths: readonly string[], cwd: string): string {
  const first = paths[0] === undefined ? cwd : resolve(cwd, paths[0]);
  const found = findRoot(first);
  if (found) return found;
  return isDirectory(first) ? first : cwd;
}

/**
 * Which files this invocation lints.
 *
 * A directory contributes the project's targets under it; a file named outright is linted whether
 * or not the project's globs would have caught it, for the same reason the root is not guarded —
 * naming it is the intent.
 */
function chosen(root: string, paths: readonly string[], cwd: string): FileRef[] {
  const targets = targetFiles(root);
  if (paths.length === 0) return targets;

  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = resolve(cwd, raw);
    if (isDirectory(path)) {
      const prefix = path.endsWith(sep) ? path : path + sep;
      for (const file of targets) {
        if ((file.path === path || file.path.startsWith(prefix)) && !seen.has(file.path)) {
          seen.add(file.path);
          out.push(file);
        }
      }
    } else if (!seen.has(path)) {
      seen.add(path);
      out.push(targets.find((f) => f.path === path) ?? { path, kind: "auto" });
    }
  }
  return out;
}

/** Runs the registry over a project and collects every finding, in file order. */
export function run(options: RunOptions): Report {
  const started = performance.now();
  const root = rootFor(options.paths, options.cwd);
  const catalog = Catalog.build(mysql, root);
  const config = get(root, undefined, options.onWarning);
  const schemas = configuredSchemas(root);

  const findings: Finding[] = [];
  const counts: Record<Severity, number> = { error: 0, warn: 0, hint: 0 };
  let linted = 0;

  for (const file of chosen(root, options.paths, options.cwd)) {
    if (options.only && !options.only.has(file.path)) continue;
    const src = catalog.read(file.path);
    if (src === undefined) continue;
    linted++;

    const lexed = tokenize(src);
    // The file sees its own `CREATE TABLE`s. A migration script both declares a table and writes
    // to it a few statements later, and against a catalog that cannot see the declaration every
    // one of those writes is reported as a table that does not exist.
    const seen = withOwnDefinitions(catalog, mysql, src, lexed);
    const diagnostics = check(options.registry, { dialect: mysql, catalog: seen, schemas, config }, src);
    // Independent of the rule registry: a file that fails to parse is still linted by the rules
    // above, which degrade against malformed input rather than refuse it — this is what tells the
    // reader those findings might be standing on a misparse, not what replaces them.
    diagnostics.push(...toDiagnostics(checkSyntax(src)));
    if (diagnostics.length === 0) continue;

    const starts = lineIndex(src);
    const path = display(root, file.path);
    // In source order. `check` returns them in the order the rules ran — document rules before
    // statement ones — which is a fact about the engine, and a report that hands a reader line 264
    // before line 96 is asking them to hold the file in their head to read it.
    diagnostics.sort((a, b) => a.span.s - b.span.s);
    for (const diagnostic of diagnostics) {
      counts[diagnostic.severity]++;
      findings.push({
        path,
        absolute: file.path,
        diagnostic,
        start: lineCol(starts, diagnostic.span.s),
        end: lineCol(starts, diagnostic.span.e),
      });
    }
  }

  return {
    root,
    findings,
    linted,
    indexed: catalog.stats.files,
    ms: performance.now() - started,
    counts,
  };
}
