/**
 * Where an engine value becomes a protocol value.
 *
 * The engine's types are deliberately not the protocol's — a `Span` rather than a `Range`, a string
 * severity rather than `1 | 2 | 4`, a string tag rather than a number — so that nothing inside the
 * engine has to know a wire format. This module is the whole of the translation, in one place,
 * once.
 *
 * It is a short module because of a decision taken at the bottom of the engine: offsets are 0-based,
 * counted in UTF-16 code units, with an exclusive end, which is exactly what the protocol asks for.
 * A `Position` here *is* the protocol's `Position`, field for field. All that is left is finding
 * which line an offset falls on, and that is a binary search over line starts.
 */

import type { Diagnostic, DiagnosticTag as EngineTag, Severity, Span } from "@sqldex/core";
import { lineCol, lineIndex } from "@sqldex/core";
import {
  DiagnosticSeverity,
  DiagnosticTag,
  type Diagnostic as ProtocolDiagnostic,
  type Range,
} from "vscode-languageserver";

/** What every diagnostic this server publishes says it came from. Clients filter and group by it. */
export const SOURCE = "sqldex";

/**
 * `Information` has no counterpart and is not invented here.
 *
 * The rules declare three levels and mean three things by them; a fourth in the translation would
 * put findings at a level no rule can ask for and no config can name.
 */
const SEVERITIES: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warn: DiagnosticSeverity.Warning,
  hint: DiagnosticSeverity.Hint,
};

/** Written out rather than mapped by hand, so a new engine tag fails to compile instead of vanishing. */
const TAGS: Record<EngineTag, DiagnosticTag> = {
  unnecessary: DiagnosticTag.Unnecessary,
};

/**
 * @param starts Line starts for the file the span is in, from `lineIndex`.
 */
export function rangeOf(starts: number[], span: Span): Range {
  return { start: lineCol(starts, span.s), end: lineCol(starts, span.e) };
}

/**
 * A file's findings, placed.
 *
 * The line index is built once for the file rather than once per finding: it is a scan of the whole
 * source, and a file with a hundred findings would otherwise pay for a hundred scans of it.
 */
export function diagnosticsOf(src: string, diagnostics: readonly Diagnostic[]): ProtocolDiagnostic[] {
  if (diagnostics.length === 0) return [];

  const starts = lineIndex(src);
  return diagnostics.map((diagnostic) => ({
    range: rangeOf(starts, diagnostic.span),
    severity: SEVERITIES[diagnostic.severity],
    code: diagnostic.code,
    source: SOURCE,
    message: diagnostic.message,
    tags: diagnostic.tags?.map((tag) => TAGS[tag]),
  }));
}
