/** Collecting ANTLR's own syntax errors, and turning its offsets into sqldex's `Span`. */

import { lineIndex } from "@sqldex/core";
import type { Span } from "@sqldex/core";
import { BaseErrorListener, Parser, ParserRuleContext } from "antlr4ng";
import type { ANTLRErrorListener, RecognitionException, Recognizer, Token as AntlrToken } from "antlr4ng";
import type { ATNSimulator } from "antlr4ng";
import { MySQLLexer } from "./generated/MySQLLexer.ts";
import { DeleteStatementContext } from "./generated/MySQLParser.ts";

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

/** What can follow a table in a `FROM` that joins: a join's first word, or the comma. */
const JOIN_STARTS = new Set([
  MySQLLexer.COMMA_SYMBOL,
  MySQLLexer.INNER_SYMBOL,
  MySQLLexer.CROSS_SYMBOL,
  MySQLLexer.JOIN_SYMBOL,
  MySQLLexer.STRAIGHT_JOIN_SYMBOL,
  MySQLLexer.LEFT_SYMBOL,
  MySQLLexer.RIGHT_SYMBOL,
  MySQLLexer.NATURAL_SYMBOL,
]);

/** The words of a join up to its `JOIN` — `INNER JOIN`, `NATURAL LEFT OUTER JOIN` — for display only. */
const JOIN_WORDS = /^(?:[A-Za-z_]+\s+){0,3}?(?:STRAIGHT_)?JOIN\b/i;

function textOf(src: string, ctx: ParserRuleContext): string {
  return src.slice(ctx.start!.start, ctx.stop!.stop + 1).replace(/\s+/g, " ");
}

/**
 * `DELETE FROM orders o INNER JOIN customers …` — a join written into the single-table form, which
 * has no room for one. The grammar's own message is `mismatched input 'INNER' expecting ';'`: by the
 * time it sees the join, `DELETE FROM orders o` is already a complete single-table `DELETE`, so all
 * it can say is that something follows it. What the reader needs is the other form — the one that
 * names the table it deletes from, `DELETE o FROM orders o INNER JOIN …`. Checked against a live
 * MariaDB server (the join, the `LEFT JOIN` and the comma all refuse to parse; `DELETE o FROM … JOIN`
 * and `DELETE FROM o USING … JOIN` both run), and MySQL's reference manual gives neither of its
 * single-table forms a join either.
 *
 * Recognised by the grammar, not by the text: at the error the parser has already closed the
 * `deleteStatement`, so it is the last rule the current context completed — and it has to be the
 * single-table alternative, **ending on its table or its alias**. A `DELETE` that got as far as a
 * `WHERE` or a `LIMIT` before a stray comma is a different mistake, and keeps the grammar's message.
 */
function explainDeleteJoin(recognizer: Recognizer<ATNSimulator>, offendingSymbol: AntlrToken | null, src: string): string | undefined {
  if (!offendingSymbol || !JOIN_STARTS.has(offendingSymbol.type) || !(recognizer instanceof Parser)) return undefined;

  let node: ParserRuleContext | null = recognizer.context;
  while (node && !(node instanceof DeleteStatementContext)) {
    let last: ParserRuleContext | null = null;
    for (const child of node.children) if (child instanceof ParserRuleContext) last = child;
    node = last;
  }
  if (!node || node.tableAliasRefList()) return undefined;

  const table = node.tableRef();
  const alias = node.tableAlias();
  const end = alias ?? table;
  if (!table || !end || node.stop?.tokenIndex !== end.stop?.tokenIndex) return undefined;

  const target = alias ? textOf(src, alias.identifier()) : textOf(src, table);
  const written = src.slice(table.start!.start, end.stop!.stop + 1).replace(/\s+/g, " ");
  const join =
    offendingSymbol.type === MySQLLexer.COMMA_SYMBOL
      ? ","
      : ` ${(JOIN_WORDS.exec(src.slice(offendingSymbol.start, offendingSymbol.start + 64))?.[0] ?? offendingSymbol.text ?? "").replace(/\s+/g, " ")}`;
  return `a DELETE that joins tables has to name the one it deletes from — DELETE ${target} FROM ${written}${join} …`;
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
  private readonly src: string;
  private readonly starts: number[];

  constructor(src: string) {
    super();
    this.src = src;
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
    this.errors.push({ span, message: explainDeleteJoin(recognizer, offendingSymbol, this.src) ?? msg });
  }
}
