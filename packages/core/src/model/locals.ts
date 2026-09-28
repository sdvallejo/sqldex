/** The IR for what only exists inside a routine's body. */

import type { Span } from "../syntax/types.ts";
import type { Routine } from "./routine.ts";
import type { ColumnType } from "./table.ts";

export type LocalKind = "param" | "variable" | "cursor" | "temp_table";

export interface Local {
  name: string;
  quoted: boolean;
  kind: LocalKind;
  type?: ColumnType;
  /** For `temp_table` only. */
  columns?: string[];
  /**
   * For `temp_table` only: tables whose columns have to be added to `columns` once a catalog is
   * at hand. This module has none, and says so instead of guessing.
   */
  sources?: string[];
  /**
   * For `temp_table` only, and only when its columns were inferred from a `SELECT` (never from an
   * explicit column list): the span of the expression that fills each one, parallel to `columns`.
   * `JSON_SET(doc, '$.id', COALESCE(order_id,0)) doc` records the span of the `JSON_SET`
   * call, which is what makes "where does this column's value come from" answerable by hover
   * rather than only "which temporary table is it a column of". Absent for a column the list could
   * not name an expression for (`Col`, `t.Col` — a plain reference, not something being computed).
   */
  columnOrigins?: (Span | undefined)[];
  /**
   * `DECLARE v INT DEFAULT 0`. For `variable` only. Without a `DEFAULT` the variable starts as
   * NULL, which is what the "read before it is ever assigned" check needs to know.
   */
  default?: boolean;
  nameSpan: Span;
}

export interface Locals {
  /** The routine containing the position asked about. */
  routine?: Routine;
  /** Table of the trigger containing it, for `NEW`/`OLD`. */
  triggerTable?: string;
  /** Everything visible from that position. */
  items: Local[];
  /** By folded name. */
  byName: Map<string, Local>;
}
