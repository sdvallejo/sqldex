/**
 * sqldex configuration: defaults, and merging with the project's `.sqldex.json`.
 *
 * Precedence is: defaults < options passed in < the root's config file. The project file wins
 * because it describes one concrete repo, while the options are global to whoever is running.
 *
 * **The keys are `snake_case`**, which is the one place where this code does not use camelCase.
 * They are not the model: they are a file format someone writes by hand into a repo and then has
 * to keep working across versions. Renaming them would buy tidiness and cost a translation table.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { DialectId } from "../dialects/dialect.ts";

export type SourceKind = "tables" | "routines" | "data" | "auto";

export interface Source {
  /** Glob relative to the project root. */
  glob: string;
  /** A parsing hint, not a restriction: it can change how much work is done, never what is found. */
  kind: SourceKind;
}

export type Severity = "error" | "warn" | "hint";

/**
 * The diagnostic families, kept as booleans for compatibility with existing config files. The
 * per-rule `rules` map is the finer layer on top; see `Config.rules`.
 */
export interface DiagnosticsConfig {
  /** Publish diagnostics while editing. A `sqldex check` run reports either way. */
  enabled: boolean;
  unqualified_columns: boolean;
  ambiguous_columns: boolean;
  null_arithmetic: boolean;
  unused_variables: boolean;
  uninitialised_variables: boolean;
  collation_mismatch: boolean;
  unfiltered_writes: boolean;
  fk_indexes: boolean;
  join_conditions: boolean;
  redundant_indexes: boolean;
  divergent_types: boolean;
  audit_sync: boolean;
}

export interface InlayHintsConfig {
  column_types: boolean;
  alias_tables: boolean;
}

export interface Config {
  /** `undefined` = autodetect from the repo layout. */
  sources?: Source[];
  /**
   * What gets linted, as opposed to what builds the catalog.
   *
   * In an editor the two coincide — you lint what you index — so a single list is tempting. They
   * are not the same thing in CI: `deploy_folder/**` contributes no definitions (its
   * `CREATE TABLE`s are copies of tables already in `tables/`) but it is code that runs and has
   * to be checked against the catalog. `undefined` = `sources`, plus `deploy_folder/**\/*.sql`
   * where that directory exists.
   */
  targets?: Source[];
  /**
   * Schemas whose tables live in this repo. `undefined` = the root's directory name.
   *
   * It exists so a reference into **another** database — `other.orders` when the repo is `shop` —
   * is not checked against a same-named table of this one: two schemas sharing a table name are
   * not the same table, and the columns of the one that is not here cannot be known.
   */
  schemas?: string[];
  /** Names or globs to skip, relative to the root. */
  exclude: string[];
  diagnostics: DiagnosticsConfig;
  inlay_hints: InlayHintsConfig;
  /**
   * Severity per rule code, on top of the family booleans: `{ "A8": "off" }`.
   *
   * The families say which group of checks runs; this says what one particular rule does, which
   * the codes only make possible now that every diagnostic carries one.
   */
  rules: Record<string, Severity | "off">;
  /** Which engine the SQL is written for. One value is implemented. */
  dialect: DialectId;
  /**
   * From the caller only. It is the one option that cannot live in the project's config file,
   * because it is used precisely to find the root — that is, before we know where that file is.
   */
  root_markers: string[];
}

export const defaults: Config = {
  sources: undefined,
  targets: undefined,
  schemas: undefined,
  // `generar_deploy.py` leaves these two at the root and they are in `.gitignore`: they are half
  // a duplicated schema and would pollute the catalog with phantom definitions.
  exclude: ["deploy.sql", "rollback.sql"],
  diagnostics: {
    enabled: false,
    // Unqualified columns (`status` instead of `o.status`).
    //
    // Unguarded this rule is unusable: every reserved word, alias and block label in the file
    // reads as a column no table has. The guards are what make it accurate — reserved words,
    // statement aliases, `SELECT` output aliases, block labels, and above all requiring that
    // **every** relation in the statement resolved, because one unknown table means any bare
    // name could be its column. With those it is precise enough to ship enabled.
    unqualified_columns: true,
    // A bare column more than one of the query's tables has: MySQL rejects it with error 1052.
    // The only rule with a scope model of its own — ambiguity is a question about a query, and
    // the `;` bound the others share merges two of them into one.
    ambiguous_columns: true,
    // `LEFT JOIN` columns used in arithmetic without `COALESCE`. If the right-hand row is
    // missing, the column is NULL and the whole expression is NULL, with no error.
    null_arithmetic: true,
    // `DECLARE` variables nobody reads. A HINT rather than a warning: it is dead code, not a bug.
    unused_variables: true,
    // A `DECLARE` with no `DEFAULT` that nothing ever assigns, and that is nevertheless read.
    // Every such read is a read of NULL, and it is the kind of bug that survives for years.
    uninitialised_variables: true,
    // A join comparing two text columns that do not share a collation. MySQL either refuses the
    // comparison or coerces one side, which rules out the index on it.
    collation_mismatch: true,
    // An `UPDATE` or `DELETE` with no `WHERE`, `JOIN`, `USING` or `LIMIT`, over a table that is
    // not temporary. Those guards are what make it usable: without them it is mostly noise about
    // scratch tables a procedure just created and is about to fill.
    unfiltered_writes: true,
    // A foreign key whose referenced columns no index on the target begins with, so InnoDB
    // cannot use one to check the constraint. order matters, not just the set of columns.
    fk_indexes: true,
    // A `JOIN` between two schema tables with neither `ON` nor `USING`: a cartesian product.
    join_conditions: true,
    // An index whose columns a longer one already begins with. A HINT: nothing is broken, and
    // dropping an index is a decision about a live database.
    redundant_indexes: true,
    // One table typing a shared column name differently from all the others.
    divergent_types: true,
    // Audit tables and triggers that have fallen behind the table they mirror. It only fires
    // where the `aud_X` convention is actually in use.
    audit_sync: true,
  },
  inlay_hints: {
    // `o.status` gains `: char(1)`. Sparse enough not to crowd the line — roughly one hint per
    // ten lines of procedure.
    column_types: true,
    // `o` gains `shipments`, but only the **first** time it appears in a statement.
    alias_tables: true,
  },
  rules: {},
  dialect: "mysql",
  root_markers: [".sqldex.json", "tablas", "tables", ".git"],
};

/**
 * Config file names, in the order they are tried.
 *
 * A list rather than a constant because the loader is written to try several and take the first:
 * a future rename gets a deprecation window for free, without touching the reader.
 */
export const CONFIG_FILES = [".sqldex.json"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge of a config over its defaults.
 *
 * Objects merge key by key; arrays and scalars replace wholesale. That is what makes
 * `exclude: []` in a project file mean "exclude nothing" rather than "keep the defaults".
 */
export function merge<T>(base: T, ...overrides: readonly (Partial<T> | undefined)[]): T {
  let out: unknown = base;
  for (const override of overrides) {
    if (override === undefined) continue;
    if (!isPlainObject(out) || !isPlainObject(override)) {
      out = override;
      continue;
    }
    const merged: Record<string, unknown> = { ...out };
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) continue;
      merged[key] = isPlainObject(value) ? merge(merged[key], value) : value;
    }
    out = merged;
  }
  return out as T;
}

/** Already-read config files, keyed by root. */
const projectCache = new Map<string, Record<string, unknown>>();

/**
 * Reads and decodes a root's config file. Returns `{}` if there is none.
 *
 * Invalid JSON is reported and treated as absent: a linter running on defaults beats a linter
 * that refuses to start.
 */
function readProjectFile(root: string, onWarning?: (message: string) => void): Record<string, unknown> {
  const cached = projectCache.get(root);
  if (cached) return cached;

  let decoded: Record<string, unknown> = {};
  for (const name of CONFIG_FILES) {
    const path = join(root, name);
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) decoded = parsed;
      else onWarning?.(`${path} is not a JSON object, ignoring it`);
    } catch (error) {
      onWarning?.(`invalid ${path}, ignoring it (${String(error)})`);
    }
    break;
  }

  projectCache.set(root, decoded);
  return decoded;
}

/** The effective config for a root. */
export function get(
  root: string,
  options?: Partial<Config>,
  onWarning?: (message: string) => void,
): Config {
  return merge(defaults, options, readProjectFile(root, onWarning) as Partial<Config>);
}

/**
 * The schemas a root defines, folded and as a set, so `x.Table` can be told apart from a
 * reference into a database this repo says nothing about.
 *
 * Folded with plain lower-casing rather than through the dialect: a schema name in a config file
 * is not an identifier read out of SQL, and reaching for the dialect from here would mean the
 * config knowing which engine it is for before it has been read. Both this and the comparison in
 * `resolve` use the same rule, which is what matters.
 */
export function schemas(root: string | undefined, options?: Partial<Config>): Set<string> {
  if (!root) return new Set();

  const declared = get(root, options).schemas;
  const names =
    declared && declared.length > 0 ? declared : [basename(root.replace(/\/+$/, ""))];
  return new Set(names.map((name) => name.toLowerCase()));
}

/** Forgets a root's cached config file (or every one), so a reindex picks up new values. */
export function invalidate(root?: string): void {
  if (root === undefined) projectCache.clear();
  else projectCache.delete(root);
}
