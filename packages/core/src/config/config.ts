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

import type { Severity } from "../diagnostics.ts";
import type { DialectId } from "../dialects/dialect.ts";
import type { RuleGroup } from "../rules/rule.ts";

export type SourceKind = "tables" | "routines" | "data" | "auto";

export interface Source {
  /** Glob relative to the project root. */
  glob: string;
  /** A parsing hint, not a restriction: it can change how much work is done, never what is found. */
  kind: SourceKind;
}

/**
 * What is reported, and how loudly.
 *
 * One mechanism at two granularities: a whole `group`, or a single rule by `id`. This used to be a
 * dozen booleans named after the rule families, which was the group in a second vocabulary that
 * had to be kept in step by hand — and a boolean can only say on or off, so raising one rule to an
 * error needed a third mechanism on top of the two.
 */
export interface DiagnosticsConfig {
  /**
   * Publish diagnostics while editing.
   *
   * On, and the switch is here for the repo where it should not be. Procedural SQL has ways of
   * naming things a static reader cannot see — SQL built as a string, a table created in another
   * session, a session variable — and a repo with enough of them wants the catalog, the navigation
   * and the completion without the underlines that come with them.
   *
   * It silences the **editor** and nothing else: `sqldex check` reports either way, so what CI fails
   * on does not move when this does. That asymmetry is the whole point of having the key rather than
   * telling people to turn every group off.
   *
   * `groups` and `rules` are the narrower knobs, and are where a repo that dislikes two rules should
   * go first. This one is the blunt instrument.
   */
  enabled: boolean;
  /** By group: `{ "audit": "off" }` in a repo with no mirror-table convention. */
  groups: Partial<Record<RuleGroup, Severity | "off">>;
  /** By rule id, which wins over its group: `{ "query/unfiltered-write": "off" }`. */
  rules: Record<string, Severity | "off">;
}

export interface InlayHintsConfig {
  column_types: boolean;
  alias_tables: boolean;
  call_parameters: boolean;
}

/**
 * Whether a real MySQL grammar also checks the file, for a class of defect the fast backend's own
 * permissive parser never detects on its own: a `CREATE TABLE` missing a comma, a mismatched
 * `BEGIN`/`END`, a file that is not SQL at all. Its own key, not folded into `DiagnosticsConfig`'s
 * `groups`/`rules`, because a syntax error is not a registry rule — there is nothing to supersede it
 * with and nothing to raise or lower its severity to, the way a rule's can be.
 *
 * Inert if `@sqldex/syntax-antlr` is not installed: this key describes intent, not capability, the
 * same way `diagnostics.enabled` still exists in a project that has turned every rule off.
 */
export interface SyntaxCheckConfig {
  enabled: boolean;
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
  syntax_check: SyntaxCheckConfig;
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
    enabled: true,
    // Empty on purpose: every rule ships at the severity it declares. What a rule is for, and
    // why it is worth its false positives, belongs in that rule's `docs` — one place, which is
    // also what `sqldex explain` prints. Restating it here as a list of flags is how the two
    // drift apart.
    groups: {},
    rules: {},
  },
  inlay_hints: {
    // `o.status` gains `: char(1)`. Sparse enough not to crowd the line — roughly one hint per
    // ten lines of procedure.
    column_types: true,
    // `o` gains `shipments`, but only the **first** time it appears in a statement.
    alias_tables: true,
    // `CALL sp_settle(1, @t)` gains `pIdOrden:` and `OUT pTotal:`. Only where the argument does not
    // already say it: an argument written with the parameter's own name needs no label.
    call_parameters: true,
  },
  // On by default, same reasoning as `diagnostics.enabled`: silently skipping a correctness check
  // most people would not think to go looking for a flag to enable is the wrong default.
  syntax_check: { enabled: true },
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
 * Roots whose unread keys have already been complained about.
 *
 * The complaint belongs to whoever can show it, and that is not whoever reads the file first: a run
 * builds its catalog before it renders anything, so the first read has nowhere to put a warning and
 * the cache would have swallowed every later chance. Keyed by root and cleared with the cache, so a
 * long-lived editor says it once per project rather than once per keystroke.
 */
const warned = new Set<string>();

/**
 * Reads and decodes a root's config file. Returns `{}` if there is none.
 *
 * Invalid JSON is reported and treated as absent: a linter running on defaults beats a linter
 * that refuses to start.
 */
function readProjectFile(root: string, onWarning?: (message: string) => void): Record<string, unknown> {
  const cached = projectCache.get(root);
  if (cached) {
    if (onWarning && !warned.has(root)) {
      warned.add(root);
      warnUnknown(join(root, CONFIG_FILES[0]), cached, onWarning);
    }
    return cached;
  }

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
      if (isPlainObject(parsed)) {
        decoded = parsed;
        if (onWarning) {
          warned.add(root);
          warnUnknown(path, decoded, onWarning);
        }
      } else onWarning?.(`${path} is not a JSON object, ignoring it`);
    } catch (error) {
      onWarning?.(`invalid ${path}, ignoring it (${String(error)})`);
    }
    break;
  }

  projectCache.set(root, decoded);
  return decoded;
}

/**
 * Keys a project file may set, and the ones inside the two nested objects.
 *
 * `root_markers` is deliberately absent: it is used to *find* the file, so a file cannot set it, and
 * saying so is more useful than accepting it and ignoring it.
 */
const KNOWN: ReadonlyMap<string, readonly string[]> = new Map([
  ["", ["sources", "targets", "schemas", "exclude", "diagnostics", "inlay_hints", "syntax_check", "dialect"]],
  ["diagnostics", ["enabled", "groups", "rules"]],
  ["inlay_hints", ["column_types", "alias_tables", "call_parameters"]],
  ["syntax_check", ["enabled"]],
]);

/**
 * Warns about a key nothing will ever read.
 *
 * A misspelling here is silent in the worst way: `"diagnostic"` for `"diagnostics"` leaves every
 * rule on, and the person who wrote it believes they turned a group off. It is the defect this
 * engine reports on in SQL — a setting that describes behaviour the code does not have — and there
 * is no reason to have it in our own file format.
 *
 * Unknown keys are still ignored rather than fatal. A project may be read by an older sqldex than
 * the one it was written for, and refusing to run because of a key from the future would make every
 * upgrade a flag day.
 */
function warnUnknown(path: string, decoded: Record<string, unknown>, onWarning?: (message: string) => void): void {
  if (!onWarning) return;
  for (const [where, allowed] of KNOWN) {
    const object = where === "" ? decoded : decoded[where];
    if (!isPlainObject(object)) continue;
    for (const key of Object.keys(object)) {
      if (allowed.includes(key)) continue;
      const near = allowed.find((candidate) => candidate.startsWith(key.slice(0, 4)));
      const inside = where === "" ? "" : ` in ${where}`;
      onWarning(
        `${path}: nothing reads ${key}${inside}${near ? `, did you mean ${near}?` : ""} — it is ignored`,
      );
    }
  }
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
  if (root === undefined) {
    projectCache.clear();
    warned.clear();
  } else {
    projectCache.delete(root);
    warned.delete(root);
  }
}
