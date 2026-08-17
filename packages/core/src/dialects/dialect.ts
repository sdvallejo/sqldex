/**
 * What a single database engine knows about itself.
 *
 * Only one dialect is implemented (`mysql`), and no second one is planned for v1. This
 * interface exists because four decisions are engine-specific and would otherwise scatter across
 * the whole codebase, which is much cheaper to concentrate now than to retrofit later:
 *
 * - **Identifier folding.** In MySQL folding every name to lower case is right; in Postgres
 *   only the *unquoted* identifier folds, so `"Customers"` and `customers` are two things. Spelled
 *   inline, that is a `name.toLowerCase()` in dozens of places across a dozen files — exactly
 *   the shape of change that never gets made.
 * - **Quoting.** Backtick here, double quote elsewhere.
 * - **Keywords.** Telling a name apart from syntax.
 * - **Types.** Whether a type carries a collation at all.
 * - **Built-in functions.** `JSON_EXTRACT` and `NOW` are MySQL's; another engine spells and
 *   documents its own.
 *
 * A `SyntaxProvider` is picked by (dialect, backend); in v1 there is exactly one pair,
 * `mysql/fast`.
 */

import type { ColumnType } from "../model/table.ts";
import type { BuiltinFunction } from "./mysql/functions.ts";

export type DialectId = "mysql";

export interface Dialect {
  readonly id: DialectId;

  /**
   * The form of a name used as a lookup key, so two spellings of the same object collide.
   *
   * `quoted` is whether the name was written delimited. MySQL ignores it; an engine with
   * case-sensitive quoted identifiers does not, which is the whole reason it is a parameter.
   */
  foldIdentifier(name: string, quoted: boolean): string;

  /** Writes a name back out delimited, escaping the delimiter. */
  quoteIdentifier(name: string): string;

  /** Is the word engine syntax rather than a name? Case-insensitive. */
  isKeyword(word: string): boolean;

  /**
   * Does this type carry a collation? Only string types do; an `int` has none, and comparing
   * one against anything is unaffected by collation.
   */
  isTextType(type: ColumnType): boolean;

  /**
   * The engine's built-in functions, keyed by their own upper-case spelling.
   *
   * Exposed as the map and not only as a lookup because completion enumerates the lot, and
   * rebuilding a list of a couple of hundred entries on every keystroke to hand back what is
   * already a map would be work done for the shape of an interface.
   */
  readonly functions: ReadonlyMap<string, BuiltinFunction>;

  /** One built-in, however it was capitalised where it was written. */
  builtin(name: string): BuiltinFunction | undefined;
}
