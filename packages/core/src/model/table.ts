/**
 * The IR for a table and its parts.
 *
 * This is where the terse field names of `syntax/` stop. Down there they are the hot loop's own
 * vocabulary; here they are the public shape the rules and the LSP see, so they are spelled out
 * and kept engine-neutral — `quoted` rather than `backticked`, `schema` rather than `database`.
 */

import type { Span } from "../syntax/types.ts";

/**
 * A column type, taken apart instead of kept as raw engine text.
 *
 * A rule that reasons about types (`decimal` precision, `int` width) can then keep meaning
 * across engines, while `raw` preserves what was written for the cases where only the exact
 * text will do — generating an `aud_` twin, or a diagnostic that quotes the source.
 */
export interface ColumnType {
  /** Folded to lower case: `varchar`, `decimal`, `enum`. */
  name: string;
  /** The parenthesised arguments as written: `["10", "2"]`, `["'A'", "'B'"]`. */
  args: string[];
  unsigned?: boolean;
  zerofill?: boolean;
  /** Exactly as written, modifiers included: `int unsigned`, `decimal(10,2)`. */
  raw: string;
}

/** How a column participates in the table's keys, in the same terms MySQL reports it. */
export type KeyKind = "PRI" | "UNI" | "MUL";

export interface Column {
  name: string;
  /** Was the name written delimited? Needed to fold it the way the engine would. */
  quoted: boolean;
  type: ColumnType;
  nullable: boolean;
  default?: string;
  comment?: string;
  autoIncrement: boolean;
  generated: boolean;
  /** The whole definition as written, for generating an `aud_` twin. */
  definition: string;
  definitionSpan: Span;
  /**
   * Effective collation of a text column: its own `COLLATE`, or the table's default. Only set
   * where it means something, so a comparison against another column can tell "both dominant"
   * from "unknown".
   */
  collation?: string;
  /** Filled in while processing the constraints. */
  key?: KeyKind;
  fk?: { table: string; column: string };
  /** Span of the name, for goto-definition. */
  nameSpan: Span;
}

export interface Index {
  name?: string;
  columns: string[];
  columnSpans: Span[];
  unique: boolean;
  /**
   * The whole clause, `UNIQUE`/`KEY`/`INDEX` through the closing parenthesis — not just the column
   * list `columnSpans` covers. What a code action needs to delete the index cleanly; absent rather
   * than guessed at when a caller builds an `Index` by hand.
   */
  span?: Span;
}

export interface ForeignKey {
  name?: string;
  columns: string[];
  /** Spans of the names as written, so a diagnostic can point at the offending one. */
  columnSpans: Span[];
  refTable?: string;
  refTableSpan?: Span;
  refColumns: string[];
  refColumnSpans: Span[];
}

export interface Table {
  name: string;
  quoted: boolean;
  /** The database in MySQL, the schema elsewhere. Set only when written qualified. */
  schema?: string;
  columns: Column[];
  /** By folded name. */
  byName: Map<string, Column>;
  primaryKey: string[];
  primaryKeySpans: Span[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
  /** The table's default, from `COLLATE=` among the table options. */
  collation?: string;
  /**
   * A temporary table only exists while the routine creating it runs: it is not part of the
   * schema and must not enter the global catalog or the file's outline.
   */
  temporary: boolean;
  nameSpan: Span;
  /** The whole statement, for hover. */
  range: Span;
  /** Engine-specific leftovers, rather than pretending they are universal. */
  extras?: Record<string, unknown>;
  /** Which file defines it. Set by the catalog, not by the parser. */
  file?: string;
}

export type TriggerTiming = "BEFORE" | "AFTER";
export type TriggerEvent = "INSERT" | "UPDATE" | "DELETE";

export interface Trigger {
  name: string;
  quoted: boolean;
  schema?: string;
  table: string;
  timing: TriggerTiming;
  event: TriggerEvent;
  nameSpan: Span;
  /** Token range of the body, for the diagnostics. */
  body: { from: number; to: number };
  /** Which file defines it. Set by the catalog, not by the parser. */
  file?: string;
}
