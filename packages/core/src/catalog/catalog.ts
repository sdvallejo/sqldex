/**
 * A DDL project's catalog: tables, columns, routines and triggers from all its `.sql` files.
 *
 * The catalog stores **offsets and paths**, not the files' text. Translating an offset into a
 * line and column, or pulling the whole `CREATE TABLE` for a hover, needs the source, which is
 * read on the spot and goes through a small cache. That keeps a repo's catalog to a few hundred
 * KB where its sources are tens of MB.
 *
 * There is deliberately no module-level registry of catalogs keyed by root, with its
 * `get`/`peek`/`invalidate`. That is editor state — a long-lived process holding several projects
 * open at once — and it belongs to whoever has that problem. A CLI run builds one catalog and
 * exits.
 */

import { readFileSync, statSync } from "node:fs";

import { triggerAudit } from "../analysis/audit.ts";
import { collect as collectValues, finish as finishValues, type ColumnValue } from "../analysis/values.ts";
import type { Dialect } from "../dialects/dialect.ts";
import type { Config, SourceKind } from "../config/config.ts";
import type { Routine } from "../model/routine.ts";
import type { ColumnType, ForeignKey, Table, Trigger } from "../model/table.ts";
import type { Span } from "../syntax/types.ts";
import { parseDDL, type ParsedDDL } from "../syntax/fast/ddl.ts";
import { tokenize } from "../syntax/fast/lexer.ts";
import { parseHeader, parseRoutines } from "../syntax/fast/routine.ts";
import { collect as collectLocals } from "../analysis/locals.ts";
import { sourceFiles, type FileRef } from "./project.ts";

/** How many sources are kept in the cache. Hover and goto bounce around a handful of tables. */
const SOURCE_CACHE_SIZE = 12;

export interface FileEntry {
  path: string;
  kind: SourceKind;
  mtime: number;
  size: number;
  /** Names defined here, folded, so they can be withdrawn on reindex. */
  tables: string[];
  routines: string[];
  triggers: string[];
  tempTables: string[];
}

export interface TempTableEntry {
  name: string;
  file: string;
  /** Filled in on demand: getting these means lexing the routine's body. */
  columns?: string[];
  sources?: string[];
  nameSpan?: Span;
}

export interface CatalogStats {
  errors: { path: string; message: string }[];
  duplicates: { name: string; files: [string, string] }[];
  tables: number;
  columns: number;
  routines: number;
  files: number;
  ms: number;
}

export interface IncomingFk {
  /** The table that declares the key. */
  table: Table;
  fk: ForeignKey;
}

/**
 * What a name lookup needs, and all that `resolve` is allowed to depend on.
 *
 * It is an interface rather than the class because the dependency runs the wrong way otherwise:
 * name resolution is a question about a catalog, not about how one was built, and a rule's test
 * wants to hand it a catalog assembled by hand rather than a directory of files.
 */
export interface CatalogLookup {
  table(name: string | undefined): Table | undefined;
  routine(name: string | undefined): Routine | undefined;
  trigger(name: string | undefined): Trigger | undefined;
  tempTable(name: string | undefined): TempTableEntry | undefined;
}

/**
 * Names of temporary tables appearing in a file.
 *
 * Pulled out with a regex over the raw text rather than by lexing, because the catalog
 * deliberately never touches routine bodies. A regex is enough because these are written in the
 * one form MySQL itself emits.
 *
 * They are needed at project level rather than per file because the pattern is one routine
 * creating the temporary table and **another** querying it after a `CALL`. Without this, those
 * references get flagged as non-existent tables, and on a procedure-heavy schema that single
 * cause accounts for most of the false positives.
 */
const TEMP_TABLE = /create[ \t\n\v\f\r]+temporary[ \t\n\v\f\r]+table[ \t\n\v\f\r]+`?([A-Za-z0-9_$]+)`?/gi;

/**
 * The `IF NOT EXISTS` form leaves the pattern above capturing `IF`; the real name comes further
 * along and is extracted separately.
 */
const TEMP_TABLE_IF_NOT_EXISTS =
  /temporary[ \t\n\v\f\r]+table[ \t\n\v\f\r]+if[ \t\n\v\f\r]+not[ \t\n\v\f\r]+exists[ \t\n\v\f\r]+`?([A-Za-z0-9_$]+)`?/gi;

function tempTableNames(src: string): string[] {
  const names: string[] = [];
  for (const match of src.matchAll(TEMP_TABLE)) names.push(match[1]!);
  for (const match of src.matchAll(TEMP_TABLE_IF_NOT_EXISTS)) names.push(match[1]!);
  return names;
}

/**
 * Is a full table parse of this file worth it?
 *
 * A plain substring search immediately discards data-only `.sql` files, which are what eats the
 * time when the layout could not be autodetected and `**\/*.sql` gets swept.
 *
 * The obvious extra test, `CREATE DEFINER`, is a trap. It is tempting because a trigger is
 * written `CREATE DEFINER=\`u\`@\`h\` TRIGGER` and so does not match `CREATE TRIGGER` — but every
 * routine is written that way too, so in a flat sweep it matches **every single file** of a
 * routines directory and each one gets lexed in full looking for tables that are not there.
 * Testing for the bare word `TRIGGER` catches the same triggers for a fraction of the files;
 * `tools/check-flat.ts` reports both numbers over a real repo.
 */
function mightHoldTable(src: string): boolean {
  return /(create[ \t\n\v\f\r]+table)|trigger/i.test(src);
}

interface Parsed {
  tables: Table[];
  routines: Routine[];
  triggers: Trigger[];
}

/**
 * Parses a file according to its `kind`, which says how much work is needed.
 *
 * The `kind` is a budget and never a filter: `auto` runs both parsers, so a flat sweep finds
 * everything a typed layout finds. `tools/check-flat.ts` holds that invariant down over a real
 * repo, which is the only place it can be checked.
 */
function parseFile(dialect: Dialect, src: string, kind: SourceKind): Parsed {
  if (kind === "routines") return { tables: [], routines: parseHeader(src), triggers: [] };

  if (kind === "tables") {
    const parsed = parseDDLWithAudit(dialect, src);
    return { tables: parsed.tables, routines: [], triggers: parsed.triggers };
  }

  // `auto` and `data`: anything may be in there, so filter cheaply before lexing.
  let tables: Table[] = [];
  let triggers: Trigger[] = [];
  if (mightHoldTable(src)) {
    const parsed = parseDDLWithAudit(dialect, src);
    tables = parsed.tables;
    triggers = parsed.triggers;
  }
  return { tables, routines: parseHeader(src), triggers };
}

/**
 * `parseDDL`, plus what each trigger's body audits.
 *
 * Read here rather than in the parser because it is a convention rather than syntax, and stored on
 * the trigger because the rule that needs it is looking at a **table** — from there no trigger's
 * tokens are in reach, and re-reading the file to get at them would be the one thing the catalog is
 * built not to do. It costs one more walk of a range this pass already delimited.
 */
function parseDDLWithAudit(dialect: Dialect, src: string): ParsedDDL {
  const lexed = tokenize(src);
  const parsed = parseDDL(dialect, src, lexed);
  for (const trigger of parsed.triggers) trigger.audit = triggerAudit(dialect, lexed.tokens, trigger);
  return parsed;
}

/** Integer types, whose display width MySQL 8 ignores: `int(11)` and `int` are one type. */
const INTEGER_TYPES: ReadonlySet<string> = new Set(["int", "bigint", "smallint", "tinyint", "mediumint"]);

/**
 * A column type reduced to what actually distinguishes it.
 *
 * The display width has to go, or the comparison invents differences: a foreign key pairing an
 * `int(11)` with an `int` is the same type on both ends, and saying otherwise is noise.
 */
export function normaliseType(type: ColumnType | undefined): string {
  if (!type) return "?";
  const low = type.raw
    .toLowerCase()
    .replace(/[ \t\n\v\f\r]+/g, " ")
    .replace(/[ \t\n\v\f\r]*collate [\s\S]*$/, "");
  const base = /^[A-Za-z0-9_]+/.exec(low)?.[0] ?? low;
  if (INTEGER_TYPES.has(base)) return base + (low.includes("unsigned") ? " unsigned" : "");
  return low;
}

/**
 * Which tables declare each foreign key name, folded.
 *
 * A cross-table fact and therefore the catalog's to answer: MySQL scopes a constraint name to the
 * **database**, not to the table, so whether a name is free is a question about every other file.
 * Standalone like the type census, so the rule and a test that builds one by hand agree.
 */
export function constraintOwners(dialect: Dialect, tables: ReadonlyMap<string, Table>): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const table of tables.values()) {
    for (const fk of table.foreignKeys) {
      if (!fk.name) continue;
      const key = dialect.foldIdentifier(fk.name, false);
      const declared = owners.get(key);
      if (declared) {
        if (!declared.includes(table.name)) declared.push(table.name);
      } else owners.set(key, [table.name]);
    }
  }
  return owners;
}

/**
 * How each column name is typed across a whole schema: `{ status: { "char(1)": 12 } }`.
 *
 * Standalone rather than a method so that the rule which reads a census and a test which builds
 * one by hand are looking at the same function. The exclusions are the reason it needs saying at
 * all: `aud_` twins and `*Mig` copies duplicate their source's columns, so counting them doubles
 * every tally without adding a case, and a migration table's stale type is not evidence about the
 * current schema.
 */
export function columnTypeCensus(
  dialect: Dialect,
  tables: ReadonlyMap<string, Table>,
): Map<string, Map<string, number>> {
  const byName = new Map<string, Map<string, number>>();
  for (const [key, table] of tables) {
    if (key.startsWith("aud_") || key.endsWith("mig")) continue;
    for (const column of table.columns) {
      const name = dialect.foldIdentifier(column.name, column.quoted);
      let kinds = byName.get(name);
      if (!kinds) byName.set(name, (kinds = new Map()));
      const kind = normaliseType(column.type);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  }
  return byName;
}

export class Catalog implements CatalogLookup {
  readonly root: string;
  readonly dialect: Dialect;
  /** By folded name. */
  readonly tables = new Map<string, Table>();
  readonly routines = new Map<string, Routine>();
  readonly triggers = new Map<string, Trigger>();
  readonly tempTables = new Map<string, TempTableEntry>();
  readonly files = new Map<string, FileEntry>();
  readonly stats: CatalogStats = {
    errors: [],
    duplicates: [],
    tables: 0,
    columns: 0,
    routines: 0,
    files: 0,
    ms: 0,
  };

  private readonly options: Partial<Config> | undefined;
  private readonly sourceCache = new Map<string, string>();
  private readonly sourceOrder: string[] = [];
  private incomingFksCache?: Map<string, IncomingFk[]>;
  /** Derivations over every table at once, by the key the asker gave them. */
  private readonly indexes = new Map<string, unknown>();
  private observedValuesCache?: Map<string, ColumnValue[]>;

  private constructor(dialect: Dialect, root: string, options?: Partial<Config>) {
    this.dialect = dialect;
    this.root = root;
    this.options = options;
  }

  /** Builds a project's catalog from scratch. */
  static build(dialect: Dialect, root: string, options?: Partial<Config>): Catalog {
    const catalog = new Catalog(dialect, root, options);
    const started = performance.now();

    for (const file of sourceFiles(root, options)) catalog.absorb(file.path, file.kind);

    catalog.recount();
    catalog.stats.ms = performance.now() - started;
    catalog.stats.files = catalog.files.size;
    return catalog;
  }

  /** Builds a catalog over an explicit file list, bypassing the project's own layout. */
  static of(dialect: Dialect, root: string, files: readonly FileRef[], options?: Partial<Config>): Catalog {
    const catalog = new Catalog(dialect, root, options);
    const started = performance.now();
    for (const file of files) catalog.absorb(file.path, file.kind);
    catalog.recount();
    catalog.stats.ms = performance.now() - started;
    catalog.stats.files = catalog.files.size;
    return catalog;
  }

  private fold(name: string, quoted = false): string {
    return this.dialect.foldIdentifier(name, quoted);
  }

  /** Removes everything a file defined, before parsing it again. */
  private retract(entry: FileEntry): void {
    for (const name of entry.tables) {
      if (this.tables.get(name)?.file === entry.path) this.tables.delete(name);
    }
    for (const name of entry.routines) {
      if (this.routines.get(name)?.file === entry.path) this.routines.delete(name);
    }
    for (const name of entry.triggers) {
      if (this.triggers.get(name)?.file === entry.path) this.triggers.delete(name);
    }
  }

  /** Parses a file and puts its definitions into the catalog. */
  private absorb(path: string, kind: SourceKind): FileEntry | undefined {
    let src;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      // The file disappeared between the glob and the read.
      return undefined;
    }

    let mtime = 0;
    let size = src.length;
    try {
      const stat = statSync(path);
      mtime = Math.floor(stat.mtimeMs / 1000);
      size = stat.size;
    } catch {
      // Same race; the entry is still usable without its stat.
    }

    const entry: FileEntry = {
      path,
      kind,
      mtime,
      size,
      tables: [],
      routines: [],
      triggers: [],
      tempTables: tempTableNames(src),
    };
    for (const name of entry.tempTables) {
      // Where it is created is stored, not its columns: getting those means lexing the routine's
      // body, and that is paid for only if somebody asks. See `tempTable`.
      this.tempTables.set(this.fold(name), { name, file: path });
    }

    let parsed;
    try {
      parsed = parseFile(this.dialect, src, kind);
    } catch (error) {
      // A file that breaks the parser cannot take the whole catalog down: note it and carry on.
      this.stats.errors.push({ path, message: String(error) });
      this.files.set(path, entry);
      return entry;
    }

    for (const item of parsed.tables) {
      // `CREATE TEMPORARY TABLE` only lives while its routine runs. Without this filter, a sweep
      // with `kind = "auto"` over a routines directory would put every scratch table a procedure
      // ever built into the global catalog as if it were part of the schema.
      if (item.temporary) continue;
      const key = this.fold(item.name, item.quoted);
      item.file = path;
      const existing = this.tables.get(key);
      if (existing && existing.file !== path) {
        this.stats.duplicates.push({ name: item.name, files: [existing.file!, path] });
      }
      this.tables.set(key, item);
      entry.tables.push(key);
    }

    for (const item of parsed.routines) {
      const key = this.fold(item.name, item.quoted);
      item.file = path;
      this.routines.set(key, item);
      entry.routines.push(key);
    }

    for (const item of parsed.triggers) {
      const key = this.fold(item.name, item.quoted);
      item.file = path;
      this.triggers.set(key, item);
      entry.triggers.push(key);
    }

    this.files.set(path, entry);
    return entry;
  }

  private recount(): void {
    let columns = 0;
    for (const table of this.tables.values()) columns += table.columns.length;
    this.stats.tables = this.tables.size;
    this.stats.columns = columns;
    this.stats.routines = this.routines.size;
  }

  /**
   * Reparses a single file. This is what runs on save: about a millisecond against the couple of
   * hundred it takes to rebuild the whole catalog.
   */
  refreshFile(path: string): boolean {
    let entry = this.files.get(path);
    if (!entry) {
      // A new file is not in the catalog yet; check whether the project claims it.
      const claimed = sourceFiles(this.root, this.options).find((file) => file.path === path);
      if (!claimed) return false;
      entry = { path, kind: claimed.kind, mtime: 0, size: 0, tables: [], routines: [], triggers: [], tempTables: [] };
    }

    this.retract(entry);
    this.sourceCache.delete(path);
    // The whole-catalog derivations are rebuilt lazily on the next ask. Editing a `CREATE TABLE`
    // is exactly when a foreign key or a column's type changes, so keeping them across a reparse
    // would answer with the schema as it was before the save.
    this.incomingFksCache = undefined;
    this.indexes.clear();
    this.observedValuesCache = undefined;

    if (!this.absorb(path, entry.kind)) this.files.delete(path);

    this.recount();
    return true;
  }

  /** A project file's source, with a small LRU cache. */
  read(path: string): string | undefined {
    const cached = this.sourceCache.get(path);
    if (cached !== undefined) return cached;

    let src;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }

    this.sourceCache.set(path, src);
    this.sourceOrder.push(path);
    if (this.sourceOrder.length > SOURCE_CACHE_SIZE) {
      const evicted = this.sourceOrder.shift()!;
      this.sourceCache.delete(evicted);
    }
    return src;
  }

  /**
   * Lookups fold the name.
   *
   * With `lower_case_table_names=0` — the default on Linux — MySQL does distinguish case in table
   * names, so in theory `Orders` and `orders` could coexist. In practice nobody does that. In
   * exchange, folding makes completion and goto work when whoever writes the query does not
   * respect the casing, which is the norm in any schema old enough to mix naming styles.
   */
  table(name: string | undefined): Table | undefined {
    return name === undefined ? undefined : this.tables.get(this.fold(name));
  }

  routine(name: string | undefined): Routine | undefined {
    return name === undefined ? undefined : this.routines.get(this.fold(name));
  }

  trigger(name: string | undefined): Trigger | undefined {
    return name === undefined ? undefined : this.triggers.get(this.fold(name));
  }

  /**
   * How each column name is typed across the whole schema:
   * `{ status: { "char(1)": 12 } }`.
   *
   * Built once and kept, because the rule that uses it runs per file: rebuilt on demand, a sweep
   * over a repo would pay for the whole schema once per file in it.
   *
   * `aud_` twins and `*Mig` copies are left out: they duplicate their source's columns, so
   * counting them doubles every tally without adding a case, and a migration table's stale type
   * is not evidence about the current schema.
   */
  index<T>(key: string, build: (tables: ReadonlyMap<string, Table>) => T): T {
    if (!this.indexes.has(key)) this.indexes.set(key, build(this.tables));
    return this.indexes.get(key) as T;
  }

  
  /**
   * Which tables point at `name` with a foreign key, and through which key.
   *
   * The catalog stores each key on the table that **declares** it, which answers "where does this
   * column lead" and not "who leads here". This is the other direction, and it is a question
   * `textDocument/references` cannot answer in practice: on a central table, the foreign keys are
   * a rounding error among the hundreds of textual hits its name gets.
   */
  incomingFks(name: string | undefined): IncomingFk[] {
    if (!this.incomingFksCache) {
      const byTarget = new Map<string, IncomingFk[]>();
      for (const table of this.tables.values()) {
        for (const fk of table.foreignKeys) {
          if (!fk.refTable) continue;
          const key = this.fold(fk.refTable);
          let list = byTarget.get(key);
          if (!list) byTarget.set(key, (list = []));
          list.push({ table, fk });
        }
      }

      // A list that reshuffles between two calls is not a list you can navigate. Two keys from
      // the same table are told apart by their columns, which is what the picker shows.
      for (const list of byTarget.values()) {
        list.sort((a, b) => {
          const an = this.fold(a.table.name);
          const bn = this.fold(b.table.name);
          if (an !== bn) return an < bn ? -1 : 1;
          const ac = a.fk.columns.join(",");
          const bc = b.fk.columns.join(",");
          return ac < bc ? -1 : ac > bc ? 1 : 0;
        });
      }

      this.incomingFksCache = byTarget;
    }

    return (name !== undefined && this.incomingFksCache.get(this.fold(name))) || [];
  }

  /**
   * The values each enum-like column is seen holding, keyed `table.column` folded.
   *
   * Built by walking every routine's body, which the catalog otherwise never does: a few hundred
   * milliseconds on a large schema, paid once and only when something asks. That is why it is not
   * part of the build — it would double the cost of opening a project, for an answer most
   * sessions never need.
   *
   * What it produces is a **lower bound**. A value no procedure compares against is still legal,
   * so this can say "these have been used" and never "these are the only ones".
   */
  observedValues(): Map<string, ColumnValue[]> {
    if (this.observedValuesCache) return this.observedValuesCache;

    const gathered = new Map<string, Set<string>>();
    for (const [path, entry] of this.files) {
      // Only sources that hold routine bodies are worth walking; a `CREATE TABLE` compares
      // nothing against anything.
      if (entry.kind === "tables") continue;
      let src;
      try {
        src = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      try {
        collectValues(this.dialect, src, (name) => this.table(name), gathered);
      } catch {
        // One unreadable file is not worth losing the rest of the answer.
      }
    }

    this.observedValuesCache = finishValues(gathered);
    return this.observedValuesCache;
  }

  /**
   * Columns of a temporary table created in **another** file of the project.
   *
   * The pattern is one routine creating the temporary table and another querying it after a
   * `CALL`, so while editing the second there is no way to know its columns without looking at
   * the first. That file is parsed on demand — a couple of milliseconds — and the result cached.
   */
  tempTable(name: string | undefined): TempTableEntry | undefined {
    if (name === undefined) return undefined;
    const entry = this.tempTables.get(this.fold(name));
    if (!entry) return undefined;
    if (entry.columns) return entry;

    const src = this.read(entry.file);
    if (src === undefined) return undefined;

    const lexed = tokenize(src);
    const scope = collectLocals(
      this.dialect,
      src,
      lexed.tokens,
      src.length,
      parseRoutines(src, lexed).routines,
    );

    // Every one in the file is filled in at once: if one is needed, its siblings probably are too.
    for (const item of scope.items) {
      if (item.kind !== "temp_table") continue;
      const other = this.tempTables.get(this.fold(item.name, item.quoted));
      if (other && other.file === entry.file && !other.columns) {
        other.columns = item.columns ?? [];
        other.sources = item.sources;
        // The span is stored too: goto-definition needs it to jump to the
        // `CREATE TEMPORARY TABLE` in the file that creates it.
        other.nameSpan = item.nameSpan;
      }
    }

    entry.columns ??= [];
    return entry;
  }
}
