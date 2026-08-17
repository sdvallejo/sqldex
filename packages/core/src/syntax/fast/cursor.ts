/**
 * Where the cursor is and what belongs there: the completion half of statement parsing, whose
 * analysis half is `stmt.ts`.
 *
 * Nothing in the linter calls this: it is what completion and signature help are built on. It
 * lives beside the statement analysis because it is the same offset arithmetic, and that
 * arithmetic is the reason this file is worth exercising over thousands of real cursor positions
 * rather than by inspection — every comparison in here is a fencepost waiting to happen.
 */

import type { Dialect } from "../../dialects/dialect.ts";
import type { Relation } from "../../model/query.ts";
import type { Token, TokenRange } from "../types.ts";
import { EXPECTS_TABLE, relations, statementBounds } from "./stmt.ts";
import { kw, kwAny, punct } from "./tok.ts";

export interface Cursor {
  /** What has been typed so far of the current identifier. */
  prefix: string;
  /** Where it starts, for building completion's textEdit. */
  prefixStart: number;
  /**
   * Index of the last complete token before the cursor.
   *
   * `undefined` means there was none at all; `-1` means the slot before the first token. The two
   * are told apart on purpose, because `classify` treats them differently: nothing typed yet is
   * not the same as sitting at the very start of a statement.
   */
  prevIdx?: number;
  /** Parenthesis depth at the cursor. */
  depth: number;
  /** Index of the `(` enclosing the cursor. */
  openIdx?: number;
}

export type ContextKind =
  | "qualified"
  | "table"
  | "routine"
  | "using"
  | "assignment"
  | "columns_of"
  | "value_of"
  | "any";

export interface Context {
  kind: ContextKind;
  /** Alias or table typed before the dot. */
  qualifier?: string;
  /** For `columns_of`: whose columns belong here. */
  table?: string;
  /** For `value_of`: the column being compared. */
  column?: string;
  /** Its alias, when it had one. */
  columnQualifier?: string;
}

/** Modifiers MySQL allows between `INSERT`/`REPLACE` and the `INTO`. */
const INSERT_MODIFIERS: ReadonlySet<string> = new Set(["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE"]);

/** Locates the cursor in the stream: which identifier is being typed and what precedes it. */
export function locateCursor(src: string, tokens: readonly Token[], offset: number): Cursor {
  let prefix = "";
  let prefixStart = offset;
  let prevIdx: number | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.s >= offset) break;
    // The cursor touches the token if it is inside it or right at its end: in `o.Id|` you are
    // typing `Id`, in `o.Id |` you are not.
    if (t.t === "id" && offset <= t.e) {
      prefix = src.slice(t.s, offset);
      prefixStart = t.s;
      prevIdx = i - 1;
      break;
    }
    prevIdx = i;
  }

  // Depth and open parenthesis at the cursor's position.
  let depth = 0;
  const stack: (number | undefined)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.e > offset) break;
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
        stack[depth] = i;
      } else if (t.v === ")") {
        stack[depth] = undefined;
        depth = Math.max(depth - 1, 0);
      }
    }
  }

  return { prefix, prefixStart, prevIdx, depth, openIdx: stack[depth] };
}

/**
 * Walks back over a reference list (`FROM a, b, |`) to see whether the cursor is still expecting
 * a table name.
 *
 * @param idx Index of the comma.
 */
function commaContinuesTableList(tokens: readonly Token[], idx: number, from: number): boolean {
  for (let i = idx - 1; i >= from; i--) {
    const t = tokens[i]!;
    if (kwAny(t, EXPECTS_TABLE)) return true;
    // Only names, aliases, dots and commas are crossed; anything else stops it.
    if (!(t.t === "id" || punct(t, ".") || punct(t, ",") || kw(t, "AS"))) return false;
  }
  return false;
}

/**
 * Is the parenthesis at `openIdx` the column list of an `INSERT INTO Foo (...)`? Returns the
 * table's name.
 *
 * The `VALUES (...)` that follows is not one: the token before **that** parenthesis is `VALUES`,
 * so it never matches, and neither does an `INSERT INTO Foo VALUES (...)` with no column list at
 * all.
 */
function insertColumnList(tokens: readonly Token[], openIdx: number): string | undefined {
  const nameIdx = openIdx - 1;
  const token = tokens[nameIdx];
  if (!token || token.t !== "id") return undefined;

  // `INSERT INTO app_prod.users (`: step over the schema qualifier, keeping the name.
  let i = nameIdx;
  const before = tokens[i - 2];
  if (punct(tokens[i - 1], ".") && before && before.t === "id") i -= 2;
  if (!kw(tokens[i - 1], "INTO")) return undefined;

  // `INSERT IGNORE INTO`, `REPLACE LOW_PRIORITY INTO`: a couple of modifiers may sit in between,
  // so the verb is looked for rather than assumed to be adjacent.
  for (let j = i - 2; j >= Math.max(i - 5, 0); j--) {
    if (kw(tokens[j], "INSERT") || kw(tokens[j], "REPLACE")) return token.v;
    if (!kwAny(tokens[j], INSERT_MODIFIERS)) return undefined;
  }
  return undefined;
}

/** The qualifier of `alias.Col`, when the token at `nameIdx` has one. */
function qualifierOf(tokens: readonly Token[], nameIdx: number): string | undefined {
  const qualifier = tokens[nameIdx - 2];
  if (punct(tokens[nameIdx - 1], ".") && qualifier && qualifier.t === "id") return qualifier.v;
  return undefined;
}

/** Classifies what is about to be typed at the cursor's position. */
export function classify(tokens: readonly Token[], cursor: Cursor, from: number): Context {
  const prev = cursor.prevIdx !== undefined ? tokens[cursor.prevIdx] : undefined;

  // `alias.` or `alias.Col`: the dot outranks every other hint.
  if (punct(prev, ".")) {
    const before = tokens[cursor.prevIdx! - 1];
    if (before && before.t === "id") return { kind: "qualified", qualifier: before.v };
  }

  // Inside `USING (...)`, what goes there are columns common to the joined tables.
  if (cursor.openIdx !== undefined && kw(tokens[cursor.openIdx - 1], "USING")) return { kind: "using" };

  // Inside `INSERT INTO Foo (...)`, only `Foo`'s columns belong. Without this the position falls
  // through to `any` and offers the whole catalog, which is not merely unhelpful: it is the one
  // place where the set of valid names is known exactly.
  if (cursor.openIdx !== undefined) {
    const tableName = insertColumnList(tokens, cursor.openIdx);
    if (tableName) return { kind: "columns_of", table: tableName };
  }

  // Right of a comparison against a column: what belongs there is one of that column's values.
  // Only the position **before** the quote is handled; once a `'` is typed the lexer sees an
  // unterminated string running to the end of the file, and nothing downstream can be trusted.
  if (prev && prev.t === "punct" && (prev.v === "=" || prev.v === "!=" || prev.v === "<>")) {
    const nameIdx = cursor.prevIdx! - 1;
    const name = tokens[nameIdx];
    if (name && name.t === "id") {
      return { kind: "value_of", column: name.v, columnQualifier: qualifierOf(tokens, nameIdx) };
    }
  }

  // Inside `Col IN (...)`, the same thing: the opening parenthesis is preceded by `IN`, which is
  // preceded by the column.
  if (cursor.openIdx !== undefined && kw(tokens[cursor.openIdx - 1], "IN")) {
    let nameIdx = cursor.openIdx - 2;
    if (kw(tokens[nameIdx], "NOT")) nameIdx--;
    const name = tokens[nameIdx];
    if (name && name.t === "id") {
      return { kind: "value_of", column: name.v, columnQualifier: qualifierOf(tokens, nameIdx) };
    }
  }

  if (kw(prev, "CALL")) return { kind: "routine" };
  if (kwAny(prev, EXPECTS_TABLE)) return { kind: "table" };
  if (
    kw(prev, "INTO") &&
    (kw(tokens[cursor.prevIdx! - 1], "INSERT") || kw(tokens[cursor.prevIdx! - 1], "REPLACE"))
  ) {
    return { kind: "table" };
  }
  if (punct(prev, ",") && commaContinuesTableList(tokens, cursor.prevIdx!, from)) {
    return { kind: "table" };
  }

  // An UPDATE's `SET Col = ...`: columns only. The `SET pVar = 1` assigning a variable inside an
  // SP is excluded because there the statement starts with `SET`, not `UPDATE`.
  if (kw(tokens[from], "UPDATE") && cursor.prevIdx !== undefined) {
    if (kw(prev, "SET")) return { kind: "assignment" };
    if (punct(prev, ",") && cursor.depth === 0) {
      for (let i = from; i <= cursor.prevIdx; i++) {
        if (kw(tokens[i], "SET")) return { kind: "assignment" };
      }
    }
  }

  return { kind: "any" };
}

export interface Analysis extends TokenRange {
  relations: Relation[];
  /** Aliases and names, both folded. An alias shadows a table name of the same spelling. */
  byAlias: Map<string, Relation>;
  cursor: Cursor;
  context: Context;
}

/** Analyses the statement surrounding the cursor. */
export function analyze(dialect: Dialect, src: string, tokens: readonly Token[], offset: number): Analysis {
  const { from, to } = statementBounds(tokens, offset);
  const found = relations(dialect, tokens, from, to);

  // An alias shadows the table name: in `FROM shipments o`, both `o.` and
  // `shipments.` must resolve, and on a clash the explicit alias wins.
  const byAlias = new Map<string, Relation>();
  for (const relation of found) {
    if (relation.name) byAlias.set(dialect.foldIdentifier(relation.name, relation.quoted === true), relation);
  }
  for (const relation of found) {
    if (relation.alias) {
      byAlias.set(dialect.foldIdentifier(relation.alias, relation.aliasQuoted === true), relation);
    }
  }

  const cursor = locateCursor(src, tokens, offset);
  return { relations: found, byAlias, cursor, context: classify(tokens, cursor, from), from, to };
}
