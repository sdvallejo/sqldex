export type { ResolvedSelect, SelectListColumns } from "./analysis/locals.ts";
export { collect, selectListColumns } from "./analysis/locals.ts";
export type { IdentifierAt, Resolved, ResolvedKind, ResolveContext } from "./analysis/resolve.ts";
export {
  columnNames,
  foreignSchema,
  identifierAt,
  qualifier,
  relation,
  tempTable,
} from "./analysis/resolve.ts";
export type { ColumnValue, ValueAccumulator } from "./analysis/values.ts";
export { fromComment, isEnumLike } from "./analysis/values.ts";
export type { CatalogLookup, CatalogStats, FileEntry, IncomingFk, TempTableEntry } from "./catalog/catalog.ts";
export { Catalog, normaliseType } from "./catalog/catalog.ts";
export type { FileRef } from "./catalog/project.ts";
export {
  detectSources,
  detectTargets,
  findRoot,
  isDdlProject,
  resolveProject,
  sourceFiles,
  targetFiles,
} from "./catalog/project.ts";
export type {
  Config,
  DiagnosticsConfig,
  InlayHintsConfig,
  Severity,
  Source,
  SourceKind,
} from "./config/config.ts";
export { CONFIG_FILES, defaults, get, invalidate, merge, schemas } from "./config/config.ts";
export type { Dialect, DialectId } from "./dialects/dialect.ts";
export { isKeyword, KEYWORDS, mysql } from "./dialects/mysql/index.ts";
export type { Local, LocalKind, Locals } from "./model/locals.ts";
export type { QueryScope, Relation } from "./model/query.ts";
export type { Param, ParamMode, Routine, RoutineKind } from "./model/routine.ts";
export type {
  Column,
  ColumnType,
  ForeignKey,
  Index,
  KeyKind,
  Table,
  Trigger,
  TriggerEvent,
  TriggerTiming,
} from "./model/table.ts";
export type { Analysis, Context, ContextKind, Cursor } from "./syntax/fast/cursor.ts";
export { analyze, classify, locateCursor } from "./syntax/fast/cursor.ts";
export type { ParsedDDL } from "./syntax/fast/ddl.ts";
export { parseDDL } from "./syntax/fast/ddl.ts";
export { lineCol, lineIndex, tokenize } from "./syntax/fast/lexer.ts";
export type { ParsedRoutines } from "./syntax/fast/routine.ts";
export { cleanDoc, parseHeader, parseRoutines } from "./syntax/fast/routine.ts";
export { cteNames, queryScopes, relations, statementBounds, statements } from "./syntax/fast/stmt.ts";
export type { Comment, Lexed, Position, Span, Token, TokenKind, TokenRange } from "./syntax/types.ts";
