/**
 * Extracts the signature of `CREATE PROCEDURE` / `CREATE FUNCTION`.
 *
 * The global catalog only needs the **header**: name, parameters and `RETURNS`. The bodies of a
 * repo's SPs are most of the bytes and contribute nothing to the catalog, so `parseHeader` lexes
 * prefixes it keeps doubling until the signature closes, rather than tokenizing the whole file.
 */

import type { Param, ParamMode, Routine, RoutineKind } from "../../model/routine.ts";
import type { Comment, Lexed, Token } from "../types.ts";
import { tokenize } from "./lexer.ts";
import { kw, kwAny, matchingParen, objectAfterCreate, punct, qualifiedName, splitCommas } from "./tok.ts";
import { readType, typeExtent } from "./type.ts";

const PARAM_MODES: ReadonlySet<string> = new Set(["IN", "OUT", "INOUT"]);

/**
 * Initial prefix to lex, chosen by measurement rather than by taste. A routine's signature and
 * its header comment almost always end within the first kilobyte, and lexing only that is several
 * times cheaper than lexing whole bodies — while a larger prefix recovers nothing more. The few
 * files that do not fit are handled by the doubling below.
 */
const INITIAL_PREFIX = 1024;

/** Returned as `nextIdx` when a signature ran past the end of the lexed prefix. */
const TRUNCATED = -1;

/** Parses a parameter: `[IN|OUT|INOUT] name type`. */
function parseParam(src: string, tokens: readonly Token[], from: number, to: number): Param | undefined {
  let i = from;
  const mode = kwAny(tokens[i], PARAM_MODES) as ParamMode | undefined;
  if (mode) i++;

  const nameToken = tokens[i];
  if (!nameToken || nameToken.t !== "id" || i + 1 > to) return undefined;

  return {
    name: nameToken.v,
    quoted: nameToken.q === true,
    type: readType(src, tokens, i + 1, typeExtent(tokens, i + 1, to)),
    mode: mode ?? "IN",
  };
}

/** Builds the signature text shown in completion and in signature help. */
function renderSignature(routine: Routine): string {
  const parts = routine.params.map((param) => {
    // `IN` is MySQL's default and reading it on every parameter adds nothing.
    const prefix = param.mode !== "IN" ? `${param.mode} ` : "";
    return `${prefix}${param.name} ${param.type.raw}`;
  });
  const signature = `${routine.name}(${parts.join(", ")})`;
  return routine.returns ? `${signature} RETURNS ${routine.returns.raw}` : signature;
}

/**
 * Parses the header of a routine starting at `keywordIdx`.
 *
 * @param keywordIdx Index of the `PROCEDURE` or `FUNCTION` token.
 */
function parseCreateRoutine(
  src: string,
  tokens: readonly Token[],
  keywordIdx: number,
  kind: RoutineKind,
): { routine: Routine | undefined; nextIdx: number } {
  let i = keywordIdx + 1;
  if (kw(tokens[i], "IF") && kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS")) i += 3;

  const named = qualifiedName(tokens, i);
  if (named.name === undefined || !named.nameToken) return { routine: undefined, nextIdx: keywordIdx + 1 };

  if (!punct(tokens[named.nextIdx], "(")) return { routine: undefined, nextIdx: named.nextIdx };
  const closeIdx = matchingParen(tokens, named.nextIdx);
  // With no closing paren the signature was cut off by the prefix: the caller doubles it.
  if (closeIdx === -1) return { routine: undefined, nextIdx: TRUNCATED };

  const params: Param[] = [];
  for (const part of splitCommas(tokens, named.nextIdx + 1, closeIdx - 1)) {
    const param = parseParam(src, tokens, part.from, part.to);
    if (param) params.push(param);
  }

  const routine: Routine = {
    name: named.name,
    quoted: named.nameToken.q === true,
    schema: named.schema,
    kind,
    params,
    // The token's real end, which with a quoted name is not `start + name.length`.
    nameSpan: { s: named.nameToken.s, e: named.nameToken.e },
    signature: "",
    headerEnd: tokens[closeIdx]!.e,
  };

  if (kw(tokens[closeIdx + 1], "RETURNS") && tokens[closeIdx + 2]) {
    const last = typeExtent(tokens, closeIdx + 2, tokens.length - 1);
    routine.returns = readType(src, tokens, closeIdx + 2, last);
    routine.headerEnd = tokens[last]!.e;
  }

  routine.signature = renderSignature(routine);
  return { routine, nextIdx: closeIdx + 1 };
}

/**
 * Cleans a block comment up for display as documentation: strips `/*`, the closing marker, the
 * leading `*` guards and the common indentation.
 */
export function cleanDoc(comment: string): string | undefined {
  const body = comment.replace(/^\/\*+/, "").replace(/\*+\/$/, "");
  const lines = body.split("\n").map((line) => {
    line = line.replace(/^\s*\*+\s?/, "").replace(/\s+$/, "");
    // SPs mix tabs and spaces for indentation. Normalising to spaces lets the common-margin
    // calculation see them alike and not leave a line un-dedented.
    return line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));
  });

  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;

  // Common indentation is noise from the file's layout, not from the text.
  let margin = Infinity;
  for (const line of lines) {
    if (line !== "") margin = Math.min(margin, /^ */.exec(line)![0].length);
  }
  if (margin > 0 && margin < Infinity) {
    for (const [i, line] of lines.entries()) lines[i] = line.slice(margin);
  }
  return lines.join("\n");
}

/**
 * Maximum distance after the signature closes within which a block comment still counts as the
 * routine's documentation. It covers the `SALIR: BEGIN` that usually sits in between.
 *
 * 399 and not a round 400 because the bound is exclusive: a comment starting exactly 399
 * characters past the header still counts, and one at 400 does not. Every boundary in this
 * function is spelled out in the same convention, which is the only way a fencepost bug here
 * stays visible.
 */
const DOC_LOOKAHEAD = 399;

/**
 * Picks the comment documenting a routine.
 *
 * It may sit before the `CREATE`, as a file-leading `/* ... *` block, or right after the
 * `BEGIN`. Both conventions are in use, and a repo usually sticks to one of them.
 */
function pickDoc(comments: readonly Comment[], routine: Routine, createOffset: number): string | undefined {
  let before: Comment | undefined;
  let after: Comment | undefined;
  for (const comment of comments) {
    if (!comment.v.startsWith("/*")) continue;
    if (comment.e <= createOffset) {
      // The last one before the `CREATE` wins: it is the one sitting against it.
      before = comment;
    } else if (
      !after &&
      comment.s >= routine.headerEnd &&
      comment.s < routine.headerEnd + DOC_LOOKAHEAD
    ) {
      after = comment;
    }
  }
  const chosen = after ?? before;
  return chosen ? cleanDoc(chosen.v) : undefined;
}

export interface ParsedRoutines {
  routines: Routine[];
  /** `true` if a signature was cut off and more prefix is needed. */
  truncated: boolean;
}

/** Parses the routines present in an already-lexed token stream. */
export function parseRoutines(src: string, lexed: Lexed): ParsedRoutines {
  const tokens = lexed.tokens;
  const routines: Routine[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (kw(tokens[i], "CREATE")) {
      const { keyword, keywordIdx } = objectAfterCreate(tokens, i);
      if (keyword === "PROCEDURE" || keyword === "FUNCTION") {
        const parsed = parseCreateRoutine(src, tokens, keywordIdx, keyword.toLowerCase() as RoutineKind);
        if (parsed.nextIdx === TRUNCATED) return { routines, truncated: true };
        if (parsed.routine) {
          parsed.routine.doc = pickDoc(lexed.comments, parsed.routine, tokens[i]!.s);
          routines.push(parsed.routine);
        }
        i = parsed.nextIdx;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return { routines, truncated: false };
}

/**
 * Is it worth looking for a routine in this file at all?
 *
 * A plain substring search for the two forms MySQL emits keeps a data-only `.sql`, with no
 * routine in it, from being lexed in full just to find nothing.
 */
function mightHoldRoutine(src: string): boolean {
  return (
    src.includes("PROCEDURE") ||
    src.includes("FUNCTION") ||
    src.includes("procedure") ||
    src.includes("function")
  );
}

/**
 * Did the prefix end in the middle of a block comment?
 *
 * The lexer closes an unterminated `/*` at the end of the text, so a last comment without its
 * closing marker means the prefix cut it. That comment is almost always the routine's
 * documentation, and half a sentence is worse in hover than none.
 *
 * Doubling until the comment closes is also what keeps the cut independent of the encoding: a
 * prefix measured in bytes lands on a different character in a file with accents than in one
 * without, and a doc comment that ends mid-word depending on the language is not a behaviour
 * worth having.
 */
function cutOffComment(lexed: Lexed): boolean {
  const last = lexed.comments[lexed.comments.length - 1];
  return last !== undefined && last.v.startsWith("/*") && !last.v.endsWith("*/");
}

/** Parses a file's routines, lexing as little as possible. */
export function parseHeader(src: string): Routine[] {
  if (!mightHoldRoutine(src)) return [];

  let size = Math.min(INITIAL_PREFIX, src.length);
  for (;;) {
    const prefix = src.slice(0, size);
    const lexed = tokenize(prefix);
    const { routines, truncated } = parseRoutines(prefix, lexed);
    if (size >= src.length) return routines;
    if (routines.length > 0 && !truncated && !cutOffComment(lexed)) return routines;
    size = Math.min(size * 2, src.length);
  }
}
