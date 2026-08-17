/**
 * MySQL SQL tokenizer.
 *
 * Not a parser: it produces a flat token stream that the `parse_*` modules walk looking for
 * the shapes they care about. It exists for one reason — skipping strings and comments
 * reliably — because nearly every bug in a regex-based approach comes from finding a `FROM`
 * inside a comment or a `)` inside a quote.
 *
 * This was chosen over treesitter after measuring both on real MySQL dumps: treesitter's `sql`
 * grammar produces ERROR nodes on every file it was fed — including a plain `CREATE TABLE` — and
 * on a large stored procedure it costs tens of milliseconds, which over a whole repo is a minute
 * of indexing for a tree nobody can trust.
 *
 * It scans UTF-16 code units with `charCodeAt` loops. No regular expressions: the whole point of
 * this file is that it is the hot loop of everything above it.
 */

import type { Comment, Lexed, Position, Token } from "../types.ts";

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const BANG = 33;
const DQUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const SQUOTE = 39;
const STAR = 42;
const DASH = 45;
const DOT = 46;
const SLASH = 47;
const ZERO = 48;
const NINE = 57;
const COLON = 58;
const LT = 60;
const EQ = 61;
const GT = 62;
const AT = 64;
const UPPER_A = 65;
const UPPER_F = 70;
const UPPER_X = 88;
const UPPER_Z = 90;
const UNDERSCORE = 95;
const BACKTICK = 96;
const LOWER_A = 97;
const LOWER_F = 102;
const LOWER_X = 120;
const LOWER_Z = 122;

/**
 * MySQL only treats `--` as a comment when whitespace or end of line follows; `a--b` is a
 * subtraction of a negative.
 */
function startsLineComment(src: string, i: number): boolean {
  if (src.charCodeAt(i + 1) !== DASH) return false;
  const after = src.charCodeAt(i + 2);
  // NaN past the end of the string, which is the "end of line" case.
  return Number.isNaN(after) || after === SPACE || after === TAB || after === LF || after === CR;
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= NINE;
}

function isHexDigit(c: number): boolean {
  return (c >= ZERO && c <= NINE) || (c >= UPPER_A && c <= UPPER_F) || (c >= LOWER_A && c <= LOWER_F);
}

/**
 * `@var` and `@@global` are a single identifier; everything else starts with a letter, `_` or
 * `$`. Anything at or above 0x80 counts too: names carry accents, and a byte-oriented test would
 * split one accented letter into two identifier characters.
 */
function isIdentStart(c: number): boolean {
  return (
    (c >= LOWER_A && c <= LOWER_Z) ||
    (c >= UPPER_A && c <= UPPER_Z) ||
    c === UNDERSCORE ||
    c === DOLLAR ||
    c >= 0x80
  );
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}

/**
 * Length of the operator starting at `i`, so that a multi-character one is not split into
 * separate tokens: `<=>`, `->>`, `<=`, `>=`, `<>`, `!=`, `:=`, `->`.
 *
 * `->` and `->>` are MySQL's JSON extraction operators, and they are no detail: any schema that
 * stores JSON is full of them. Without them, `payload->>'$.Id'` leaves a stray `-` that expression
 * analysis reads as a subtraction.
 *
 * Written as a code comparison rather than a table lookup on `src.slice(i, i + 3)` because
 * punctuation is the most common token there is, and slicing twice per `,` is not free.
 */
function operatorLength(src: string, i: number): number {
  const c1 = src.charCodeAt(i + 1);
  switch (src.charCodeAt(i)) {
    case LT:
      // `<=>` and `<=`, or `<>`.
      if (c1 === EQ) return src.charCodeAt(i + 2) === GT ? 3 : 2;
      return c1 === GT ? 2 : 1;
    case DASH:
      // `->>` and `->`.
      if (c1 === GT) return src.charCodeAt(i + 2) === GT ? 3 : 2;
      return 1;
    case GT:
    case BANG:
    case COLON:
      return c1 === EQ ? 2 : 1;
    default:
      return 1;
  }
}

/** Interned single-character punctuation, so the common case allocates nothing. */
const PUNCT1: string[] = [];
for (let c = 0; c < 128; c++) PUNCT1.push(String.fromCharCode(c));

/**
 * Scans a delimited literal and returns the offset of its closing quote.
 *
 * If the literal was left unclosed (truncated file, half-written DDL) it returns the last
 * offset of the text: a strange token beats aborting the parse of the whole file.
 *
 * Backticks do not use `\` to escape: inside them only the doubled `` `` `` counts.
 */
function scanLiteral(src: string, openAt: number, quote: number): number {
  const len = src.length;
  const escapes = quote !== BACKTICK;
  let j = openAt + 1;
  while (j < len) {
    const c = src.charCodeAt(j);
    if (c === quote) {
      // Doubled quote: an escaped literal, not the closing one.
      if (src.charCodeAt(j + 1) === quote) {
        j += 2;
        continue;
      }
      return j;
    }
    // Backslash: eats the next character, whatever it is.
    if (escapes && c === 0x5c) {
      j += 2;
      continue;
    }
    j++;
  }
  return len - 1;
}

/**
 * Turns SQL into tokens. Comments do not enter the stream: they are gathered separately,
 * where hover needs them (an SP's leading block comment) and so do the diagnostics (the
 * `sqldex:ignore` suppression).
 */
export function tokenize(src: string): Lexed {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const len = src.length;
  let i = 0;

  // Depth of mysqldump's `/*!NNNNN ... */` blocks. MySQL executes what is inside, so we read
  // it too: a raw dump's `CREATE TABLE` may carry a trailing `/*!50100 PARTITION BY ... */`,
  // and discarding it wholesale would lose the table.
  let gated = 0;

  while (i < len) {
    const c = src.charCodeAt(i);

    if (c === SPACE || c === TAB || c === LF || c === CR) {
      i++;
      while (i < len) {
        const w = src.charCodeAt(i);
        if (w !== SPACE && w !== TAB && w !== LF && w !== CR) break;
        i++;
      }
    } else if (c === HASH || (c === DASH && startsLineComment(src, i))) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? len : nl;
      comments.push({ v: src.slice(i, stop), s: i, e: stop });
      i = stop;
    } else if (c === SLASH && src.charCodeAt(i + 1) === STAR && src.charCodeAt(i + 2) === BANG) {
      // Opening a version-gated block: skip `/*!` and the version number, and carry on
      // tokenizing the contents as ordinary SQL.
      gated++;
      let j = i + 3;
      while (isDigit(src.charCodeAt(j))) j++;
      i = j;
    } else if (c === SLASH && src.charCodeAt(i + 1) === STAR) {
      const closeAt = src.indexOf("*/", i + 2);
      const stop = closeAt === -1 ? len : closeAt + 2;
      comments.push({ v: src.slice(i, stop), s: i, e: stop });
      i = stop;
    } else if (c === STAR && src.charCodeAt(i + 1) === SLASH && gated > 0) {
      gated--;
      i += 2;
    } else if (c === BACKTICK) {
      const closeAt = scanLiteral(src, i, BACKTICK);
      // A doubled `` `` `` inside the name collapses to a literal backtick.
      const raw = src.slice(i + 1, closeAt);
      tokens.push({
        t: "id",
        v: raw.includes("``") ? raw.replaceAll("``", "`") : raw,
        s: i,
        e: closeAt + 1,
        q: true,
      });
      i = closeAt + 1;
    } else if (c === SQUOTE || c === DQUOTE) {
      // Without ANSI_QUOTES — MySQL's default — double quotes are strings too, not identifiers.
      const closeAt = scanLiteral(src, i, c);
      tokens.push({ t: "str", v: src.slice(i, closeAt + 1), s: i, e: closeAt + 1 });
      i = closeAt + 1;
    } else if (isDigit(c)) {
      const next = src.charCodeAt(i + 1);
      let stop: number;
      if (c === ZERO && (next === LOWER_X || next === UPPER_X)) {
        let j = i + 2;
        while (isHexDigit(src.charCodeAt(j))) j++;
        // `0x` with nothing after it is not a hex literal: emit the `0` on its own and let the
        // `x` start an identifier.
        stop = j > i + 2 ? j : i + 1;
      } else {
        let j = i;
        while (isDigit(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) === DOT) {
          j++;
          while (isDigit(src.charCodeAt(j))) j++;
        }
        stop = j;
      }
      tokens.push({ t: "num", v: src.slice(i, stop), s: i, e: stop });
      i = stop;
    } else {
      let j = i;
      if (src.charCodeAt(j) === AT) {
        j++;
        if (src.charCodeAt(j) === AT) j++;
      }
      if (isIdentStart(src.charCodeAt(j))) {
        j++;
        while (isIdentPart(src.charCodeAt(j))) j++;
        tokens.push({ t: "id", v: src.slice(i, j), s: i, e: j, q: false });
        i = j;
      } else {
        const n = operatorLength(src, i);
        tokens.push({
          t: "punct",
          v: n === 1 && c < 128 ? PUNCT1[c]! : src.slice(i, i + n),
          s: i,
          e: i + n,
        });
        i += n;
      }
    }
  }

  return { tokens, comments };
}

/** Offsets where each line starts, for translating token positions into lines. */
export function lineIndex(src: string): number[] {
  const starts = [0];
  let nl = src.indexOf("\n");
  while (nl !== -1) {
    starts.push(nl + 1);
    nl = src.indexOf("\n", nl + 1);
  }
  return starts;
}

/**
 * Translates an offset into a line and a column.
 *
 * Binary search over the line index: O(log n) per query, which matters because hover and
 * goto-definition call it for every symbol they resolve.
 */
export function lineCol(starts: number[], offset: number): Position {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}
