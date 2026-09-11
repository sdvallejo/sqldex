/**
 * Reading a routine's own `DECLARE` section — the consecutive declarations MySQL requires at the
 * top of a `BEGIN … END`, in the order the grammar itself demands them: variables and conditions,
 * then cursors, then handlers.
 *
 * Read once, here, because more than one caller has to walk it correctly: a rule deciding whether a
 * `DECLARE` sits after the block's first statement, and a quick fix deciding where a new one belongs
 * and whether it can join an existing list instead of adding a line of its own.
 */

import type { ColumnType } from "../../model/table.ts";
import type { Span, Token } from "../types.ts";
import { kw, kwAny, punct } from "./tok.ts";
import { readType, typeExtent } from "./type.ts";

export type DeclarationKind = "variable" | "condition" | "cursor" | "handler";

export interface Declaration {
  readonly kind: DeclarationKind;
  /** Index of the `DECLARE` token itself. */
  readonly from: number;
  /** Index of this declaration's own terminating `;`. */
  readonly to: number;
  /** `variable` only: the names it declares, comma-separated in the grammar and sharing one type. */
  readonly names?: readonly Span[];
  /** `variable` only: its type, read the same way a column's is. */
  readonly type?: ColumnType;
  /**
   * `variable` only: whether something follows the type before the `;` — a `DEFAULT`, a
   * `CHARACTER SET`, a `COLLATE`. A list with one of these is never a safe one to append a name to:
   * the new name would inherit it, and a `DEFAULT` in particular would change what the variable
   * starts as.
   */
  readonly hasModifier?: boolean;
}

/** `DECLARE CONTINUE|EXIT|UNDO HANDLER …` — the one kind of declaration whose own name is not a
 * usable identifier. Mirrors `analysis/locals.ts`'s own set. */
const HANDLER_STARTERS: ReadonlySet<string> = new Set(["CONTINUE", "EXIT", "UNDO"]);

/**
 * Words after `END` that close a statement rather than the enclosing block. Mirrors
 * `routine/declare-after-statement`'s own set: a handler's action can itself be a
 * `BEGIN … END … ;`, which is the one declaration whose terminating `;` is not the first one found
 * at parenthesis depth zero.
 */
const NOT_A_BLOCK_END: ReadonlySet<string> = new Set(["IF", "WHILE", "LOOP", "REPEAT", "CASE"]);

/**
 * The index of the `;` that ends the declaration starting at `from`, tracking parenthesis depth and
 * block depth together.
 *
 * Block depth is what a plain scan for the next `;` gets wrong on a handler with a `BEGIN … END`
 * action: `DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN SET @done = 1; END;` has its first `;`
 * **inside** that block, and the declaration does not end until the second one.
 */
function declarationEnd(tokens: readonly Token[], from: number): number {
  let to = from;
  let blocks = 0;
  let parens = 0;
  while (to < tokens.length) {
    const t = tokens[to]!;
    if (kw(t, "BEGIN")) blocks++;
    else if (kw(t, "END") && kwAny(tokens[to + 1], NOT_A_BLOCK_END) === undefined) {
      if (blocks > 0) blocks--;
    } else if (punct(t, "(")) parens++;
    else if (punct(t, ")")) parens--;
    else if (blocks === 0 && parens === 0 && punct(t, ";")) return to;
    to++;
  }
  return tokens.length - 1;
}

/**
 * Reads one declaration starting at `from` — the index of its own `DECLARE` token — classified and
 * bounded the same way `declarationSection` reads each of a block's own.
 *
 * Usable on **any** `DECLARE`, not only one sitting at the top of its block: a misplaced one, which
 * is a `DECLARE` after the block's first statement, is exactly the shape that is not there. A quick
 * fix that wants to move one back has to read it first, and reads it with this rather than a second,
 * looser copy of the same grammar.
 *
 * `undefined` when `from` is not a `DECLARE` at all, or names a shape this reader does not know.
 */
export function readDeclaration(src: string, tokens: readonly Token[], from: number): Declaration | undefined {
  if (!kw(tokens[from], "DECLARE")) return undefined;
  let j = from + 1;

  if (kwAny(tokens[j], HANDLER_STARTERS) !== undefined) {
    return { kind: "handler", from, to: declarationEnd(tokens, from) };
  }

  // Names are comma-separated, and MySQL puts every one of them before the type:
  // `DECLARE a, b, c INT DEFAULT 0;`.
  const names: Span[] = [];
  while (tokens[j]?.t === "id") {
    names.push({ s: tokens[j]!.s, e: tokens[j]!.e });
    if (punct(tokens[j + 1], ",")) j += 2;
    else {
      j++;
      break;
    }
  }
  if (names.length === 0) return undefined;

  if (kw(tokens[j], "CURSOR")) return { kind: "cursor", from, to: declarationEnd(tokens, from) };
  if (kw(tokens[j], "CONDITION")) return { kind: "condition", from, to: declarationEnd(tokens, from) };

  const typeEnd = typeExtent(tokens, j, tokens.length - 1);
  const type = readType(src, tokens, j, typeEnd);
  const to = declarationEnd(tokens, from);
  return { kind: "variable", from, to, names, type, hasModifier: to > typeEnd + 1 };
}

/**
 * The consecutive `DECLARE`s starting right after `beginIdx`, MySQL's grammar order: variables and
 * conditions, then cursors, then handlers.
 *
 * Stops at the first token that is not a `DECLARE`, which is exactly the bound MySQL itself
 * enforces — nothing here has to re-derive `routine/declare-after-statement`'s own check to know
 * where the section ends.
 *
 * @param beginIdx Index of the block's own `BEGIN` token.
 */
export function declarationSection(src: string, tokens: readonly Token[], beginIdx: number): Declaration[] {
  const out: Declaration[] = [];
  let i = beginIdx + 1;

  while (kw(tokens[i], "DECLARE")) {
    const declaration = readDeclaration(src, tokens, i);
    if (!declaration) break; // a shape this reader does not know: stop rather than loop forever
    out.push(declaration);
    i = declaration.to + 1;
  }

  return out;
}
