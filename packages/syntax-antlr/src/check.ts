/** A real MySQL grammar, run for its syntax errors alone — nothing here extracts structure. */

import { CharStream, CommonTokenStream } from "antlr4ng";
import { MySQLLexer } from "./generated/MySQLLexer.ts";
import { MySQLParser } from "./generated/MySQLParser.ts";
import { CollectingErrorListener } from "./errors.ts";
import type { SyntaxError } from "./errors.ts";

export type { SyntaxError } from "./errors.ts";

/**
 * Every character set name MySQL 8.0 ships (`SHOW CHARACTER SET`), plus `utf8` — the pre-8.0 alias
 * for `utf8mb3`, still a real charset introducer on a current server even though it isn't in that
 * table any more — each written **with its leading underscore**, matching what `this.text` actually
 * holds at the point `checkCharset` runs (`_utf8mb4`, not `utf8mb4`); a set built from the bare names
 * silently never matches anything, since `Set.has` is exact.
 *
 * The lexer's own `checkCharset(text)` (`MySQLLexerBase.ts`) decides whether a `_word` token is a
 * charset introducer (`_utf8mb4'...'`, the form mysqldump normalises every string literal to
 * whenever a column's collation differs from the connection's) or just a plain identifier, by
 * looking the word up in `lexer.charSets` — which starts as an **empty** `Set`, never populated by
 * anything in the vendored code. Left empty, every charset introducer in every file lexes as a bare
 * identifier immediately followed by an unrelated string token, with nothing joining them — which
 * was first misdiagnosed here as a grammar ambiguity specific to `REPLACE(...)`/`IF(...)` (both
 * genuinely fragile, per the grammar's own "Function calls with other conflicts" comment,
 * `MySQLParser.g4` ~3095-3108) before this was found to be the real, and fully fixable, cause: with
 * `charSets` populated, `REPLACE`/`IF` parse a charset-introduced argument exactly as cleanly as
 * every other function already did.
 */
const MYSQL_CHARSETS = [
  "_armscii8",
  "_ascii",
  "_big5",
  "_binary",
  "_cp1250",
  "_cp1251",
  "_cp1256",
  "_cp1257",
  "_cp850",
  "_cp852",
  "_cp866",
  "_cp932",
  "_dec8",
  "_eucjpms",
  "_euckr",
  "_gb18030",
  "_gb2312",
  "_gbk",
  "_geostd8",
  "_greek",
  "_hebrew",
  "_hp8",
  "_keybcs2",
  "_koi8r",
  "_koi8u",
  "_latin1",
  "_latin2",
  "_latin5",
  "_latin7",
  "_macce",
  "_macroman",
  "_sjis",
  "_swe7",
  "_tis620",
  "_ucs2",
  "_ujis",
  "_utf16",
  "_utf16le",
  "_utf32",
  "_utf8",
  "_utf8mb3",
  "_utf8mb4",
] as const;

/**
 * This project's own convention — one routine per file, no trailing `;`/`$$` after the closing
 * `END` — is not a MySQL syntax error; it is the file-boundary convention `routine/declare-after-
 * statement` and friends already read a body against. The grammar's `queries: query* EOF` rule
 * requires a terminator on every statement including the last, so a file ending exactly on `END`
 * fails with `missing ';' at '<EOF>'` on every single well-formed routine in this shape — measured
 * on real files from the private corpora, appending the missing `;` fixes it.
 *
 * A file that fails for a different reason — genuinely truncated mid-statement, not just missing its
 * final terminator — still gets caught: appending one `;` to a truncated `BEGIN` block does not
 * balance it, and the parser reports the real error underneath.
 *
 * **Whether the file, ignoring trailing blank lines, trailing whole-line comments, and a trailing
 * inline comment on the last real line, already ends with a `;`.**
 *
 * Skipping whole-line comments on the way back is what `stripDelimiterDirectives` needs: a
 * `DELIMITER ;` reset at end of file becomes a blanked comment line, so the real terminator two
 * lines earlier (`;;` converted to `;`) would otherwise be invisible to a check that only looked at
 * the very last character. Skipping a trailing *inline* comment on the last real line is separate
 * and was found the same way — measured on a real deploy script ending
 * `INSERT INTO … VALUES (…); -- Sistemas`: the line does not literally end with `;`, but it does end
 * with a statement terminator followed by a comment, and treating that as "no terminator yet" adds a
 * second, empty `;` the grammar has no rule for (`query: (simpleStatement | beginWork)
 * SEMICOLON_SYMBOL` — nothing satisfies a bare `;`).
 *
 * Two mistakes this earlier considered and rejected: trimming trailing whitespace before checking
 * corrupts a blanked comment (its required trailing space is what makes it a comment at all, not two
 * `-` tokens); appending a terminator unconditionally, without checking first, was the original bug.
 */
function endsWithTerminator(src: string): boolean {
  const TRAILING_TERMINATOR = /;[ \t]*(--.*|#.*)?$/;
  const lines = src.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("--") || line.startsWith("#")) continue;
    return TRAILING_TERMINATOR.test(line);
  }
  // Nothing but blank lines and whole-line comments in the entire file — including a genuinely
  // empty file (measured: a real, empty `CREATE VIEW` source, 0 bytes). `queries: query* EOF`
  // accepts zero queries; there is no statement here to need a terminator, and appending one
  // creates an empty, unparseable `;` where there was nothing before it.
  return true;
}

function normaliseTerminator(src: string): string {
  return endsWithTerminator(src) ? src : `${src}\n;`;
}

/**
 * `DELIMITER $$` is a `mysql` client command, never real SQL — the server never sees it, which is
 * exactly why the grammar (correctly) refuses it. Measured on the four private corpora: 429 of
 * `db`'s syntax errors were files where a `CREATE TABLE` is immediately followed by
 * `DELIMITER ;;` / a block of `CREATE TRIGGER ... END\n;;` — the ordinary shape of a table's
 * triggers appended after it, mysqldump's own convention.
 *
 * A directive line is **blanked in place**, and the custom delimiter it names is swapped for `;` —
 * but **only where that delimiter is the last thing on its line**, which covers both real shapes
 * measured: alone on its own line (`END` on one line, `;;` on the next) and glued straight onto the
 * closing `END` (`END$$`, no space). Not a lexer-aware substitution: a `$$` or `;;` occurring earlier
 * in a line — inside a string, say — is left untouched on purpose, because guessing there risks
 * turning real content into a false terminator, which is the opposite failure from the one this
 * guard exists to fix; anchoring on the end of the line is what keeps that guess narrow.
 *
 * **The delimiter a directive names stays active for every statement after it, not just the next
 * one** — real `mysql`-client behaviour, and the bug that survived first-pass testing here: a single
 * `DELIMITER ;;` ahead of several `CREATE TRIGGER … END\n;;` blocks (one `AFTER INSERT`, one
 * `AFTER UPDATE`, both sharing it) converted only the *first* trigger's `;;` correctly, because the
 * first pass reset the active delimiter back to `;` right after converting one occurrence — leaving
 * every trigger after the first with its `;;` untouched and unparseable. There is no reset here
 * except a new `DELIMITER` line saying so.
 *
 * Every replacement keeps the line's exact original length — a comment padded with spaces, a `;`
 * padded the same way. `checkSyntax`'s spans are offsets into whatever text was actually parsed;
 * shortening a line here would shift every offset after it, so every error downstream in the same
 * file would point at the wrong place in the source the caller actually has.
 */
function stripDelimiterDirectives(src: string): string {
  const DIRECTIVE = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*$/i;
  let delimiter = ";";
  const lines = src.split("\n").map((line) => {
    const directive = DIRECTIVE.exec(line);
    if (directive) {
      delimiter = directive[1]!;
      // A `--` comment, blank rather than removed, so nothing after it moves.
      return line.length >= 2 ? `--${" ".repeat(line.length - 2)}` : line;
    }
    if (delimiter !== ";" && line.endsWith(delimiter)) {
      const idx = line.length - delimiter.length;
      return line.slice(0, idx) + ";" + " ".repeat(delimiter.length - 1);
    }
    return line;
  });
  return lines.join("\n");
}

/**
 * `col->>"$.path"` / `col->"$.path"`: MySQL's ordinary way to write a JSON path argument to the
 * `->`/`->>` operators — the standard shape across all four private corpora this was measured
 * against, not a rare one. The vendored grammar's `ANSI_QUOTES` default (see the comment on the
 * lexer/parser construction in `checkSyntax`) reads a double-quoted string as a quoted *identifier*
 * there, not a string literal, which both fails to parse on its own and cascades into further
 * unrelated-looking errors later in the same statement — confirmed on a real file, where one
 * `->>"..."` produced four errors, only the first of which pointed at the actual token.
 *
 * Turning the outer quote characters into single quotes ahead of parsing is a real fix, not a guard:
 * MySQL string literals mean the same thing under either quoting style, so the rewritten source is
 * still exactly what the query means. Same length-preserving text-substitution technique
 * `stripDelimiterDirectives` already uses above — swapping one delimiter character for another changes
 * nothing about the offsets `checkSyntax`'s spans point into.
 *
 * Restricted to a path containing no quote or backslash character at all — every real path measured
 * across the four corpora (`$.foo.bar`, `$[0].x`, `$.*`, none of them) qualifies. A path that does
 * contain one is left untouched, so it fails exactly as it did before this normalisation existed
 * (and `errors.ts`'s `isKnownGrammarGap` still suppresses it as a known gap) rather than risk turning
 * an embedded `'` into a premature string terminator by guessing at how to escape it.
 */
function normaliseJsonPathQuotes(src: string): string {
  return src.replace(/(->>?)(\s*)"([^"'\\]*)"/g, (_match, arrow: string, ws: string, path: string) => `${arrow}${ws}'${path}'`);
}

function normalise(src: string): string {
  return normaliseTerminator(normaliseJsonPathQuotes(stripDelimiterDirectives(src)));
}

/**
 * Parses `src` against the real MySQL grammar and returns every syntax error found, each with the
 * `Span` it occurred at. Empty means the file parses — nothing about the fast backend's own,
 * separate findings changes either way; the two run independently and both are reported.
 */
export function checkSyntax(src: string): SyntaxError[] {
  const normalised = normalise(src);
  const chars = CharStream.fromString(normalised);
  const listener = new CollectingErrorListener(normalised);

  const lexer = new MySQLLexer(chars);
  lexer.charSets = new Set(MYSQL_CHARSETS);
  // The vendored MySQLLexerBase/MySQLParserBase constructors default to ANSI_QUOTES active, which
  // reads a double-quoted string as a quoted *identifier*. That is measurably wrong for one shape —
  // `data->>"$.path"`, the ordinary way to write a JSON path argument to `->>` — because `->>`'s
  // grammar rule specifically wants a text-string-literal there. Turning ANSI_QUOTES off everywhere
  // was tried and reverted: it breaks a far more common shape, a double-quoted string as an ordinary
  // function argument (`CONCAT("ERROR ", ...)`, `JSON_OBJECT` keys) — that path apparently never
  // routes through `textStringLiteral`'s ANSI_QUOTES-off alternative at all, only the identifier one,
  // so with the mode off those stop parsing instead. Measured on the four private corpora: leaving
  // the grammar's own default in place is the smaller loss by a wide margin. `normaliseJsonPathQuotes`
  // (above) fixes the common case a different way — rewriting the JSON-path shape itself before it
  // ever reaches the lexer — without needing to touch this mode at all; only a path containing a
  // quote or backslash character, which that normalisation deliberately leaves alone, still depends
  // on `isKnownGrammarGap` in `errors.ts` to stay quiet.
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);

  const tokens = new CommonTokenStream(lexer);
  const parser = new MySQLParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(listener);
  parser.queries();

  return listener.errors;
}
