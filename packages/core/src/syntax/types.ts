/**
 * The token stream, and the offset convention the whole core is built on.
 *
 * ## Offsets
 *
 * Everything here is **0-based, counted in UTF-16 code units, with an exclusive end** — the
 * convention LSP asks for, adopted at the very bottom rather than converted to at the edge. A
 * language server that stores offsets in any other unit needs a translation layer over every
 * position it ever emits; JS strings are already UTF-16, so choosing this convention here makes
 * that layer unnecessary instead of merely cheap.
 *
 * The field names are deliberately short (`t`/`v`/`s`/`e`/`q`): a token is allocated once per
 * few characters of SQL, and this is the one place in the codebase where terseness pays for
 * itself. The spelled-out names start at `model/`.
 */

/** A range of source text: `s` inclusive, `e` exclusive, in UTF-16 code units. */
export interface Span {
  s: number;
  e: number;
}

/**
 * A range of the token stream, by index.
 *
 * Both ends are **inclusive**, unlike a `Span`. The two conventions are on purpose and the
 * reason they carry different type names: source offsets follow LSP, which wants an exclusive
 * end, while a token range is walked with `for (let i = from; i <= to; i++)` and reads far
 * better closed. Mixing them up is caught by the type, which is the whole point of the split.
 */
export interface TokenRange {
  from: number;
  to: number;
}

export type TokenKind = "id" | "str" | "num" | "punct";

export interface Token {
  /** Token class. */
  t: TokenKind;
  /** The token's text; for a backticked `id`, already without the backticks. */
  v: string;
  /** Start offset. */
  s: number;
  /** End offset, exclusive. */
  e: number;
  /** `true` if the identifier was quoted. */
  q?: boolean;
}

export interface Comment {
  /** Full text, marker included. */
  v: string;
  s: number;
  /** End offset, exclusive. */
  e: number;
}

export interface Lexed {
  tokens: Token[];
  comments: Comment[];
}

/** A position in a document, in LSP's terms. */
export interface Position {
  /** 0-based. */
  line: number;
  /** 0-based, in UTF-16 code units. */
  character: number;
}
