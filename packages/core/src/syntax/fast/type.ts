/**
 * Reading a type off the token stream. Shared by column definitions and routine parameters,
 * which spell types the same way.
 */

import type { ColumnType } from "../../model/table.ts";
import type { Token } from "../types.ts";
import { kwAny, matchingParen, punct, splitCommas } from "./tok.ts";

/** Suffixes that are still part of the type rather than the rest of the definition. */
export const TYPE_SUFFIXES: ReadonlySet<string> = new Set(["UNSIGNED", "SIGNED", "ZEROFILL", "PRECISION"]);

/**
 * Index of the last token of the type starting at `start`: its parenthesised arguments if any,
 * plus the modifiers that follow (`unsigned`, `double precision`).
 *
 * @param limit Last token index the type is allowed to reach.
 */
export function typeExtent(tokens: readonly Token[], start: number, limit: number): number {
  let last = start;
  if (punct(tokens[start + 1], "(")) {
    const close = matchingParen(tokens, start + 1);
    if (close !== -1) last = close;
  }
  while (last < limit && kwAny(tokens[last + 1], TYPE_SUFFIXES)) last++;
  return last;
}

/**
 * Takes the type apart: name, parenthesised arguments and the modifiers that follow.
 *
 * `raw` keeps the text exactly as written, and stays the reference for anything that has to
 * reproduce it — an `aud_` twin, a rendered signature, a diagnostic quoting the source. The
 * parsed parts are for comparing types, never for printing them back.
 */
export function readType(src: string, tokens: readonly Token[], start: number, end: number): ColumnType {
  const nameToken = tokens[start]!;
  const type: ColumnType = {
    name: nameToken.v.toLowerCase(),
    args: [],
    raw: src.slice(nameToken.s, tokens[end]!.e),
  };

  if (punct(tokens[start + 1], "(")) {
    const close = matchingParen(tokens, start + 1);
    if (close !== -1) {
      for (const part of splitCommas(tokens, start + 2, close - 1)) {
        type.args.push(src.slice(tokens[part.from]!.s, tokens[part.to]!.e));
      }
    }
  }

  for (let i = start + 1; i <= end; i++) {
    const suffix = kwAny(tokens[i], TYPE_SUFFIXES);
    if (suffix === "UNSIGNED") type.unsigned = true;
    else if (suffix === "ZEROFILL") type.zerofill = true;
  }

  return type;
}
