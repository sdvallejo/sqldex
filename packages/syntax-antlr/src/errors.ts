/** Collecting ANTLR's own syntax errors, and turning its offsets into sqldex's `Span`. */

import { lineIndex } from "@sqldex/core";
import type { Span } from "@sqldex/core";
import { BaseErrorListener } from "antlr4ng";
import type { ANTLRErrorListener, RecognitionException, Recognizer, Token as AntlrToken } from "antlr4ng";
import type { ATNSimulator } from "antlr4ng";
import { MySQLLexer } from "./generated/MySQLLexer.ts";

export interface SyntaxError {
  span: Span;
  message: string;
}

/**
 * Two confirmed limitations in the vendored grammar itself, not defects in the SQL being checked —
 * each measured against real files, root-caused rather than guessed at, and otherwise noise about a
 * reader's own working code. `check.test.ts` carries the evidence for each; this is where they
 * become guards, the same discipline every rule's false positives go through elsewhere in sqldex.
 * A false negative here — missing a genuinely different defect that happens to share a token type —
 * is the accepted direction of error, same as everywhere else a guard exists in this project.
 *
 * A third candidate, `REPLACE(...)`/`IF(...)` with a charset-introduced literal argument, turned out
 * not to belong here: it was a real, fixable bug in how `checkSyntax` built the lexer (`charSets`
 * left empty — see the comment there), not a grammar limitation. Fixed at the source instead of
 * guarded around.
 */
function isKnownGrammarGap(offendingSymbol: AntlrToken | null): boolean {
  if (!offendingSymbol) return false;

  // `URL` as a bare column/table name. `URL_SYMBOL` has exactly one real use in this grammar
  // (`LOAD DATA ... URL`) and is missing from every list a non-reserved keyword falls back to being
  // a plain identifier through — confirmed against MySQL's own docs, which list `URL` (added in
  // 8.0.32) as non-reserved. A grammar omission, not a genuine ambiguity.
  if (offendingSymbol.type === MySQLLexer.URL_SYMBOL) return true;

  // `col->>"$.path"` / `col->"$.path"`: a double-quoted JSON path read as an ANSI_QUOTES identifier.
  // No `sqlModes` setting fixes this shape without breaking the far more common "double-quoted
  // string as an ordinary function argument" one — see the comment where `checkSyntax` builds the
  // lexer and parser.
  if (offendingSymbol.type === MySQLLexer.DOUBLE_QUOTED_TEXT && offendingSymbol.text?.startsWith('"$')) return true;

  return false;
}

/**
 * Collects every syntax error ANTLR reports, rather than stopping at the first.
 *
 * ANTLR's default recovery strategy resynchronizes after an error and keeps parsing, so one
 * malformed file can — and should — report more than one error, the same way `check()` returns
 * every rule violation rather than the first.
 */
export class CollectingErrorListener extends BaseErrorListener implements ANTLRErrorListener {
  readonly errors: SyntaxError[] = [];
  private readonly starts: number[];

  constructor(src: string) {
    super();
    this.starts = lineIndex(src);
  }

  override syntaxError<S extends AntlrToken, T extends ATNSimulator>(
    recognizer: Recognizer<T>,
    offendingSymbol: S | null,
    line: number,
    column: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    if (isKnownGrammarGap(offendingSymbol)) return;

    // `offendingSymbol` carries absolute character offsets directly — no line/column math needed —
    // whenever there's a real token to point at. It can be null for some lexer-level errors (an
    // unterminated string, say), where the only position ANTLR has is the (line, column) pair.
    const span: Span = offendingSymbol
      ? { s: offendingSymbol.start, e: offendingSymbol.stop + 1 }
      : (() => {
          const s = (this.starts[line - 1] ?? 0) + column;
          return { s, e: s + 1 };
        })();
    this.errors.push({ span, message: msg });
  }
}
