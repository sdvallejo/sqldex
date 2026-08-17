/**
 * Traversal helpers over the token stream from `lexer.ts`.
 *
 * Shared by `ddl`, `routine`, `stmt` and `locals`. Everything here takes a token **index**;
 * indices are 0-based, and the `{ from, to }` ranges are inclusive at both ends (see
 * `TokenRange` in `../types.ts`).
 */

import type { Span, Token, TokenRange } from "../types.ts";

/**
 * Is the token the keyword `word` (case-insensitively)?
 *
 * It requires the identifier **not** to be quoted: in a dump, a column called `` `key` `` or a
 * table `` `order` `` are names, not syntax. Confusing the two is the easiest way to misparse a
 * table that uses a reserved word as a name.
 *
 * @param word In UPPER CASE.
 */
export function kw(token: Token | undefined, word: string): boolean {
  return token !== undefined && token.t === "id" && !token.q && token.v.toUpperCase() === word;
}

/** Is the token any of the given keywords? Returns which one, or `undefined`. */
export function kwAny(token: Token | undefined, words: ReadonlySet<string>): string | undefined {
  if (token === undefined || token.t !== "id" || token.q) return undefined;
  const up = token.v.toUpperCase();
  return words.has(up) ? up : undefined;
}

/**
 * Strips the quotes off a literal and undoes the escapes.
 *
 * Both forms are real and not defensive: doubled `''` is what MySQL emits when it writes a dump,
 * and `\'` is what people type by hand.
 *
 * @param literal The token's raw text, quotes included.
 */
export function unquote(literal: string): string {
  const quote = literal.slice(0, 1);
  let body = literal.slice(1, -1);
  body = body.replaceAll(quote + quote, quote);
  return body.replace(/\\([\s\S])/g, (_, c: string) => {
    if (c === "n") return "\n";
    if (c === "t") return "\t";
    if (c === "r") return "\r";
    if (c === "0") return "\0";
    return c;
  });
}

/** Is the token the given punctuation mark? */
export function punct(token: Token | undefined, char: string): boolean {
  return token !== undefined && token.t === "punct" && token.v === char;
}

/** Index of the `)` closing the `(` at `openIdx`, or `-1`. */
export function matchingParen(tokens: readonly Token[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
      } else if (t.v === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Splits a token range on depth-zero commas.
 *
 * This is what separates the definitions of a `CREATE TABLE` and a routine's parameters,
 * without a comma inside `decimal(10,2)` or `AS (if((a),1,0))` splitting too much.
 */
export function splitCommas(tokens: readonly Token[], from: number, to: number): TokenRange[] {
  const parts: TokenRange[] = [];
  let start = from;
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
      } else if (t.v === ")") {
        depth--;
      } else if (t.v === "," && depth === 0) {
        if (i > start) parts.push({ from: start, to: i - 1 });
        start = i + 1;
      }
    }
  }
  if (start <= to) parts.push({ from: start, to });
  return parts;
}

/** Sort markers that appear in an index's column list and are not names. */
const NOT_A_COLUMN: ReadonlySet<string> = new Set(["ASC", "DESC"]);

export interface ColumnList {
  names: string[];
  /** Index of the matching `)`, or `-1` if it was never closed. */
  closeIdx: number;
  /** Source span of each name, parallel to `names`. */
  spans: Span[];
  /**
   * Whether each name was written delimited, parallel to `names`. MySQL does not care, but
   * folding a name correctly is the dialect's call and it cannot make it without this.
   */
  quoted: boolean[];
}

/**
 * Column names from an `(a, b, c)` list, ignoring length prefixes (`col(10)`) and `ASC`/`DESC`.
 *
 * It also returns each name's span. The diagnostics that check an index or a foreign key
 * against the catalog need it: pointing the warning at the constraint as a whole says which one
 * is wrong but not which column, which is the part you have to fix.
 *
 * @param openIdx Index of the `(`.
 */
export function columnList(tokens: readonly Token[], openIdx: number): ColumnList {
  const closeIdx = matchingParen(tokens, openIdx);
  if (closeIdx === -1) return { names: [], closeIdx: -1, spans: [], quoted: [] };

  const names: string[] = [];
  const spans: Span[] = [];
  const quoted: boolean[] = [];
  let depth = 0;
  for (let i = openIdx; i <= closeIdx; i++) {
    const t = tokens[i]!;
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
      } else if (t.v === ")") {
        depth--;
      }
    } else if (t.t === "id" && depth === 1 && !NOT_A_COLUMN.has(t.v.toUpperCase())) {
      names.push(t.v);
      spans.push({ s: t.s, e: t.e });
      quoted.push(t.q === true);
    }
  }
  return { names, closeIdx, spans, quoted };
}

/**
 * Clauses that can sit between `CREATE` and the object type: `DEFINER=x@y`, `OR REPLACE`,
 * `ALGORITHM=UNDEFINED`, `SQL SECURITY DEFINER`, `TEMPORARY`, `UNIQUE`...
 */
const OBJECT_KEYWORDS: ReadonlySet<string> = new Set([
  "TABLE",
  "TRIGGER",
  "PROCEDURE",
  "FUNCTION",
  "VIEW",
  "INDEX",
  "DATABASE",
  "SCHEMA",
  "EVENT",
]);

/**
 * Given a `CREATE` at `createIdx`, finds which kind of object it defines.
 *
 * It skips whatever is in between rather than enumerating every possible clause: that is
 * shorter and does not break on a new clause from a future MySQL version.
 *
 * Returns `keyword: undefined` when there is none within reach.
 */
export function objectAfterCreate(
  tokens: readonly Token[],
  createIdx: number,
): { keyword: string | undefined; keywordIdx: number } {
  // 16 tokens are enough for the longest prefix that exists in practice,
  // ``CREATE ALGORITHM=UNDEFINED DEFINER=`u`@`h` SQL SECURITY DEFINER VIEW``, and they bound the
  // cost in a file where `CREATE` appears hundreds of times.
  const limit = Math.min(createIdx + 16, tokens.length - 1);
  for (let i = createIdx + 1; i <= limit; i++) {
    const word = kwAny(tokens[i], OBJECT_KEYWORDS);
    if (word) return { keyword: word, keywordIdx: i };
  }
  return { keyword: undefined, keywordIdx: -1 };
}

export interface QualifiedName {
  name: string | undefined;
  /** Index of the token after the name. */
  nextIdx: number;
  schema: string | undefined;
  /** The token the name itself sits on — what goto-definition points at. */
  nameToken: Token | undefined;
}

/**
 * Reads an object name, resolving the qualified `schema.object` form.
 *
 * Repos have references like `app_prod.users`; the schema is returned separately
 * because the catalog covers a single database and the name to look up is always the last
 * segment.
 *
 * @param idx Index of the first identifier.
 */
export function qualifiedName(tokens: readonly Token[], idx: number): QualifiedName {
  const first = tokens[idx];
  if (!first || first.t !== "id") {
    return { name: undefined, nextIdx: idx, schema: undefined, nameToken: undefined };
  }

  const third = tokens[idx + 2];
  if (punct(tokens[idx + 1], ".") && third && third.t === "id") {
    return { name: third.v, nextIdx: idx + 3, schema: first.v, nameToken: third };
  }
  return { name: first.v, nextIdx: idx + 1, schema: undefined, nameToken: first };
}
