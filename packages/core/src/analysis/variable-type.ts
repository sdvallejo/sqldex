/**
 * What a `DECLARE` for an undeclared local would look like, inferred from how it is already used.
 *
 * Only ever a guess offered as a starting point — never a claim the way the rest of the catalog's
 * derivations are — which is why the caller that wants it (the "Declare `<name>`" quick fix) is free
 * to fall back to a `/* type *\/` marker rather than trust a wrong one.
 */

import type { CatalogLookup } from "../catalog/catalog.ts";
import type { Dialect } from "../dialects/dialect.ts";
import type { Locals } from "../model/locals.ts";
import type { Relation } from "../model/query.ts";
import type { ColumnType } from "../model/table.ts";
import { relation as resolveRelation } from "./resolve.ts";
import { opensStatement, relations } from "../syntax/fast/stmt.ts";
import { kw, kwAny, matchingParen, punct, splitCommas } from "../syntax/fast/tok.ts";
import { readType, typeExtent } from "../syntax/fast/type.ts";
import type { Token, TokenRange } from "../syntax/types.ts";

export interface InferVariableTypeInput {
  dialect: Dialect;
  catalog: CatalogLookup;
  src: string;
  tokens: readonly Token[];
  locals: Locals;
}

/**
 * The `CAST`/`CONVERT` target types this rule can carry into a `DECLARE`, mapped to what a
 * `DECLARE` accepts instead — verified against a live server rather than assumed, because the
 * obvious mapping (the exact result type) is the wrong one.
 *
 * The criterion is **the widest type the expression can produce**, not its result type: MariaDB
 * sizes `CAST(1 AS UNSIGNED)` as `int(1) unsigned`, by the argument's own length, and `BIGINT
 * UNSIGNED` is what holds every value that could come out of it regardless. `CHAR`/`BINARY` without
 * a length is the trap the other way — `DECLARE v CHAR` is `CHAR(1)`, and a value longer than the
 * `CAST`'s own argument fails at runtime rather than truncating in silence, so a length-less cast is
 * left as `undefined` rather than guessed at.
 */
function castMapping(type: ColumnType): ColumnType | undefined {
  switch (type.name) {
    case "signed":
      return { name: "bigint", args: [], raw: "BIGINT" };
    case "unsigned":
      return { name: "bigint", args: [], unsigned: true, raw: "BIGINT UNSIGNED" };
    case "decimal":
    case "date":
    case "datetime":
    case "time":
    case "json":
    case "double":
    case "float":
    case "real":
    case "year":
      return type;
    case "char":
      return type.args.length === 1 ? { name: "varchar", args: type.args, raw: `VARCHAR(${type.args[0]})` } : undefined;
    case "binary":
      return type.args.length === 1
        ? { name: "varbinary", args: type.args, raw: `VARBINARY(${type.args[0]})` }
        : undefined;
    default:
      return undefined;
  }
}

/** Strips matching outer parentheses off a range, as many layers as there are. */
function unwrapParens(tokens: readonly Token[], range: TokenRange): TokenRange {
  let { from, to } = range;
  while (punct(tokens[from], "(") && punct(tokens[to], ")") && matchingParen(tokens, from) === to) {
    from++;
    to--;
  }
  return { from, to };
}

/**
 * `CAST(e AS T)` or `CONVERT(e, T)`, when the **whole** range is exactly one such call — not part
 * of a larger expression, which this deliberately does not attempt to read into.
 */
function fromCastOrConvert(src: string, tokens: readonly Token[], range: TokenRange): ColumnType | undefined {
  const { from, to } = range;
  const head = tokens[from];
  if (!head || !punct(tokens[from + 1], "(")) return undefined;
  const close = matchingParen(tokens, from + 1);
  if (close === -1 || close !== to) return undefined;

  if (kw(head, "CAST")) {
    let depth = 0;
    let asIdx = -1;
    for (let i = from + 2; i < close; i++) {
      if (punct(tokens[i], "(")) depth++;
      else if (punct(tokens[i], ")")) depth--;
      else if (depth === 0 && kw(tokens[i], "AS")) {
        asIdx = i;
        break;
      }
    }
    if (asIdx === -1) return undefined;
    const typeEnd = typeExtent(tokens, asIdx + 1, close - 1);
    return castMapping(readType(src, tokens, asIdx + 1, typeEnd));
  }

  if (kw(head, "CONVERT")) {
    const parts = splitCommas(tokens, from + 2, close - 1);
    // `CONVERT(expr USING charset)` has no comma at all and is a different question entirely.
    if (parts.length !== 2) return undefined;
    const typePart = parts[1]!;
    const typeEnd = typeExtent(tokens, typePart.from, typePart.to);
    return castMapping(readType(src, tokens, typePart.from, typeEnd));
  }

  return undefined;
}

/** Is this item range exactly a bare `col` or a qualified `t.col`? */
function columnReference(tokens: readonly Token[], item: TokenRange): { qualifier?: string; column: string } | undefined {
  if (item.from === item.to && tokens[item.from]?.t === "id") {
    return { column: tokens[item.from]!.v };
  }
  if (
    item.to === item.from + 2 &&
    tokens[item.from]?.t === "id" &&
    punct(tokens[item.from + 1], ".") &&
    tokens[item.to]?.t === "id"
  ) {
    return { qualifier: tokens[item.from]!.v, column: tokens[item.to]!.v };
  }
  return undefined;
}

/** The type of a select-list item that is a bare or qualified column of one of `queryFrom..queryTo`'s
 * own relations, resolved against the catalog. */
function fromColumnReference(
  input: InferVariableTypeInput,
  queryFrom: number,
  queryTo: number,
  item: TokenRange,
): ColumnType | undefined {
  const ref = columnReference(input.tokens, item);
  if (!ref) return undefined;

  const { dialect, tokens, catalog, locals } = input;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const rels = relations(dialect, tokens, queryFrom, queryTo);

  let target: Relation | undefined;
  if (ref.qualifier !== undefined) {
    const key = fold(ref.qualifier);
    target = rels.find(
      (r) => (r.alias !== undefined && fold(r.alias) === key) || (r.alias === undefined && r.name !== undefined && fold(r.name) === key),
    );
  } else if (rels.length === 1) {
    target = rels[0];
  }
  if (!target) return undefined;

  const resolved = resolveRelation({ dialect, catalog, schemas: new Set<string>() }, locals, target);
  return resolved?.table?.byName.get(fold(ref.column))?.type;
}

/** A select-list item's type: a `CAST`/`CONVERT`, or a column reference — the same two rules a
 * scalar subquery's own single item and a `SELECT … INTO`'s own item are read by. */
function itemType(input: InferVariableTypeInput, queryFrom: number, queryTo: number, item: TokenRange): ColumnType | undefined {
  return fromCastOrConvert(input.src, input.tokens, item) ?? fromColumnReference(input, queryFrom, queryTo, item);
}

/** The right-hand side of a `target = value` or `target := value`, up to the next depth-0 comma
 * or `;` — `undefined` when `target` is not actually the start of an assignment. */
function assignmentRhs(tokens: readonly Token[], targetIdx: number, limit: number): TokenRange | undefined {
  if (!punct(tokens[targetIdx + 1], "=") && !punct(tokens[targetIdx + 1], ":=")) return undefined;

  let depth = 0;
  for (let j = targetIdx + 2; j <= limit; j++) {
    const t = tokens[j]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && (punct(t, ";") || punct(t, ","))) {
      return j > targetIdx + 2 ? { from: targetIdx + 2, to: j - 1 } : undefined;
    }
  }
  return limit >= targetIdx + 2 ? { from: targetIdx + 2, to: limit } : undefined;
}

/**
 * A `SET`/expression right-hand side's type: a `CAST`/`CONVERT`, a scalar subquery of a single
 * item (itself read the same two ways), or a bare local/parameter that already carries a type.
 */
function fromExpression(input: InferVariableTypeInput, range: TokenRange): ColumnType | undefined {
  const { tokens } = input;
  const unwrapped = unwrapParens(tokens, range);

  const cast = fromCastOrConvert(input.src, tokens, unwrapped);
  if (cast) return cast;

  if (kw(tokens[unwrapped.from], "SELECT")) {
    const list = selectList(tokens, unwrapped.from, unwrapped.to);
    if (!list) return undefined;
    const items = splitCommas(tokens, list.from, list.to);
    return items.length === 1 ? itemType(input, unwrapped.from, unwrapped.to, items[0]!) : undefined;
  }

  if (unwrapped.from === unwrapped.to) {
    const token = tokens[unwrapped.from];
    if (token?.t === "id") {
      const local = input.locals.byName.get(input.dialect.foldIdentifier(token.v, token.q === true));
      if (local?.type) return local.type;
    }
  }

  return undefined;
}

/** Clause words that end a select list at its own depth — the small set this module needs, kept
 * local for the same reason `OPENS_STATEMENT` above is. */
const AFTER_LIST: ReadonlySet<string> = new Set([
  "FROM",
  "INTO",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "WINDOW",
  "PROCEDURE",
  "FOR",
  "LOCK",
  "ON",
]);

const SELECT_MODIFIERS: ReadonlySet<string> = new Set(["ALL", "DISTINCT", "DISTINCTROW", "HIGH_PRIORITY", "SQL_CALC_FOUND_ROWS"]);

/** The select list opened at `selectIdx`, ending at the first depth-0 clause or `;`. */
function selectList(tokens: readonly Token[], selectIdx: number, to: number): TokenRange | undefined {
  let first = selectIdx + 1;
  while (kwAny(tokens[first], SELECT_MODIFIERS) !== undefined) first++;

  let depth = 0;
  for (let i = first; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) {
      if (depth === 0) return i > first ? { from: first, to: i - 1 } : undefined;
      depth--;
    } else if (depth === 0 && (punct(t, ";") || kwAny(t, AFTER_LIST) !== undefined)) {
      return i > first ? { from: first, to: i - 1 } : undefined;
    }
  }
  return to >= first ? { from: first, to } : undefined;
}

/** The `INTO` of this range, at its own depth, excluding a file destination. */
function intoAt(tokens: readonly Token[], from: number, to: number): number {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "INTO")) {
      return kw(tokens[i + 1], "OUTFILE") || kw(tokens[i + 1], "DUMPFILE") ? -1 : i;
    }
  }
  return -1;
}

/** This range's own statements, cut on `;` and `BEGIN` — the same bound every other statement
 * traversal in this engine uses. */
function statementsIn(tokens: readonly Token[], from: number, to: number): TokenRange[] {
  const out: TokenRange[] = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (punct(tokens[i], ";") || kw(tokens[i], "BEGIN")) {
      if (i > start) out.push({ from: start, to: i - 1 });
      start = i + 1;
    }
  }
  if (start <= to) out.push({ from: start, to });
  return out;
}

/** Equality for the purpose of joining a `DECLARE` list or agreeing across several writes: `name`,
 * `args` (normalised without spaces), `unsigned`, `zerofill` — never `raw`, which only ever
 * documents how one of the two was written. */
export function sameColumnType(a: ColumnType, b: ColumnType): boolean {
  const norm = (args: readonly string[]): string => args.map((arg) => arg.replace(/\s+/g, "")).join(",");
  return (
    a.name === b.name &&
    norm(a.args) === norm(b.args) &&
    (a.unsigned ?? false) === (b.unsigned ?? false) &&
    (a.zerofill ?? false) === (b.zerofill ?? false)
  );
}

/**
 * What a `DECLARE` for `name` would look like, inferred from every write of it in `body` — or
 * `undefined` when none can be read, or two of them disagree.
 *
 * Each write offers the first source that applies: its own `CAST`/`CONVERT`, a scalar subquery
 * (itself read the same way, or as a column reference), a `SELECT … INTO` destination read against
 * the matching item of that `SELECT`'s own list, or a bare local/parameter that already has a type.
 * A write that fits none of those is simply skipped rather than counted against the others — only an
 * actual disagreement between two inferred writes gives up on the whole answer.
 */
export function inferVariableType(input: InferVariableTypeInput, name: string, body: TokenRange): ColumnType | undefined {
  const { dialect, tokens } = input;
  const fold = (token: Token): string => dialect.foldIdentifier(token.v, token.q === true);
  const key = dialect.foldIdentifier(name, false);
  const candidates: ColumnType[] = [];

  // Every `SET name = …` / `SET name := …` that opens a statement of its own.
  for (let i = body.from; i <= body.to; i++) {
    if (!kw(tokens[i], "SET") || !opensStatement(tokens, i, body.from)) continue;

    let depth = 0;
    let expecting = true;
    for (let j = i + 1; j <= body.to; j++) {
      const token = tokens[j]!;
      if (punct(token, "(")) depth++;
      else if (punct(token, ")")) depth--;
      else if (punct(token, ";") && depth === 0) break;
      else if (punct(token, ",") && depth === 0) {
        expecting = true;
        continue;
      }
      if (!expecting || depth !== 0) continue;
      expecting = false;
      if (token.t !== "id" || fold(token) !== key) continue;

      const rhs = assignmentRhs(tokens, j, body.to);
      if (!rhs) continue;
      const found = fromExpression(input, rhs);
      if (found) candidates.push(found);
    }
  }

  // Every `SELECT … INTO name, …` in the body.
  // Wherever a `SELECT` opens a statement, not just where a range does: the range of
  // `IF … THEN SELECT … INTO v` starts at the `IF`.
  for (const stmt of statementsIn(tokens, body.from, body.to)) {
    for (let at = stmt.from; at <= stmt.to; at++) {
      if (!kw(tokens[at], "SELECT") || !opensStatement(tokens, at, stmt.from)) continue;
      const into = intoAt(tokens, at, stmt.to);
      if (into === -1) continue;
      const list = selectList(tokens, at, stmt.to);
      if (!list) continue;
      const items = splitCommas(tokens, list.from, list.to);

      let position = 0;
      let j = into + 1;
      while (tokens[j]?.t === "id") {
        if (fold(tokens[j]!) === key) {
          const item = items[position];
          if (item) {
            const found = itemType(input, at, stmt.to, item);
            if (found) candidates.push(found);
          }
        }
        position++;
        if (punct(tokens[j + 1], ",")) j += 2;
        else break;
      }
    }
  }

  if (candidates.length === 0) return undefined;
  const first = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    if (!sameColumnType(first, candidate)) return undefined;
  }
  return first;
}
