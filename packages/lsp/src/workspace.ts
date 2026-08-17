/**
 * The project, live: the catalog every answer comes from, and the events that make it stale.
 *
 * Split out of the server because the two have different jobs. The server owns the protocol —
 * requests, notifications, when to publish — and this owns the question "what does the schema look
 * like right now", which is the one thing every feature needs and the one thing that goes wrong
 * quietly when it is wrong.
 *
 * ## What the catalog reflects, and what it does not
 *
 * **The catalog is built from what is on disk.** An unsaved buffer is not in it, and that is
 * deliberate: a half-typed `CREATE TABLE` is not a table yet, and a catalog that flickered on every
 * keystroke would make every answer in every other file flicker with it. It is brought up to date
 * one file at a time on save, which costs about a millisecond against the couple of hundred a
 * rebuild takes.
 *
 * The gap that leaves — the file you are editing, seen against a catalog that has not read your
 * edits — is closed for that file by the overlay in `diagnose`, which is the one place where seeing
 * your own unsaved definitions is both cheap and clearly what you meant.
 *
 * ## Changes the editor never tells you about
 *
 * A standalone server has a problem an in-editor one does not: files change without any buffer
 * being involved. A branch switch rewrites hundreds of `.sql` files, and nothing in the text
 * document notifications says so. That is what `refresh` is for, driven by watched-file events,
 * and it is the reason the server asks the client to watch in the first place.
 */

import {
  allRules,
  Catalog,
  check,
  CONFIG_FILES,
  get,
  invalidate,
  mysql,
  schemas as configuredSchemas,
  tokenize,
  withOwnDefinitions,
  type Config,
  type Diagnostic,
  type Registry,
} from "@sqldex/core";
import { basename } from "node:path";

export class Workspace {
  readonly root: string;
  /** Registration order decides which rule claims a token, so it is the engine's list, unfiltered. */
  readonly registry: Registry;

  /**
   * Replaced wholesale by `reload`, never patched. Nothing should hold one of these across a
   * request: after a config change the old catalog is not stale, it is a different project.
   */
  catalog: Catalog;
  config: Config;
  schemas: ReadonlySet<string>;

  constructor(root: string) {
    this.root = root;
    this.registry = allRules();
    this.catalog = Catalog.build(mysql, root);
    this.config = get(root);
    this.schemas = configuredSchemas(root);
  }

  /**
   * What the rules say about one file's current text.
   *
   * The text is the caller's, not the catalog's, because in an editor the buffer is the truth about
   * the file being looked at even when the disk disagrees.
   *
   * The file sees its own `CREATE TABLE`s. That exists for migration scripts, which declare a table
   * and write to it a few statements later, but it earns its place in an editor too: a column added
   * to a `CREATE TABLE` is visible to the rest of the file before the file is saved.
   */
  diagnose(src: string): Diagnostic[] {
    const lexed = tokenize(src);
    const seen = withOwnDefinitions(this.catalog, mysql, src, lexed);
    return check(this.registry, { dialect: mysql, catalog: seen, schemas: this.schemas, config: this.config }, src);
  }

  /**
   * Brings one file's definitions up to date.
   *
   * @returns whether the catalog changed, which is what tells the caller if other files' answers
   * are now different. A file the project does not claim as a source — anything under a targets-only
   * directory, anything outside the globs — reports `false` and costs a lookup.
   */
  refresh(path: string): boolean {
    return this.catalog.refreshFile(path);
  }

  /** Does a path change what the project *is*, rather than what is in it? */
  static isConfigFile(path: string): boolean {
    return CONFIG_FILES.some((name) => basename(path) === name);
  }

  /**
   * Rebuilds everything, for when the config file changed.
   *
   * Nothing survives: the config decides which files are sources at all, so a catalog built under
   * the old one holds definitions this project may no longer make and be missing ones it now does.
   * There is no incremental version of that, and trying to have one is how a linter ends up
   * reporting against a schema that never existed.
   */
  reload(): void {
    invalidate(this.root);
    this.config = get(this.root);
    this.schemas = configuredSchemas(this.root);
    this.catalog = Catalog.build(mysql, this.root);
  }
}
