/** The IR for a stored procedure or function. */

import type { Span } from "../syntax/types.ts";
import type { ColumnType } from "./table.ts";

export type ParamMode = "IN" | "OUT" | "INOUT";

export interface Param {
  name: string;
  quoted: boolean;
  type: ColumnType;
  mode: ParamMode;
}

export type RoutineKind = "procedure" | "function";

export interface Routine {
  name: string;
  quoted: boolean;
  schema?: string;
  kind: RoutineKind;
  params: Param[];
  returns?: ColumnType;
  /** Leading block comment, cleaned up for hover. */
  doc?: string;
  /** Span of the name, for goto-definition. */
  nameSpan: Span;
  /** `name(pA int, pB char(1))`, already formatted for completion and signature help. */
  signature: string;
  /** Offset where the signature ends. */
  headerEnd: number;
  /** Which file defines it. Set by the catalog, not by the parser. */
  file?: string;
}
