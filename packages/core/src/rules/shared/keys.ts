/**
 * What pins a row down: the columns a clause fixes, and whether they add up to a key.
 *
 * Four rules ask this and they had better agree — a join that half-fixes a composite key, a subquery
 * read as one value, a `SELECT … INTO`, a search read as a lookup. All of them are the same question
 * asked in different places.
 */

import type { Relation } from "../../model/query.ts";
import type { Table } from "../../model/table.ts";
import { kw, kwAny, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { BaseContext, ScopeInfo } from "../rule.ts";
import { foldsToOneRow, limitsToOne } from "./rows.ts";

/**
 * What `singleTableQuery`/`isKeyLookup` need of a context: the scope lookup, not a whole statement.
 *
 * `StatementContext` satisfies this structurally, and so does `RoutineContext` now that it carries
 * the same `scopeAt` — which is what lets the taint of `SET v = (SELECT …)` ask the same "is this a
 * key lookup" question from routine scope that a statement rule asks from its own.
 */
export type ScopedContext = BaseContext & { scopeAt(index: number): ScopeInfo | undefined };

/**
 * Is `wanted` the leftmost prefix of `columns`, position by position?
 *
 * Position is the whole point. An index on `(register_id, store_id)` cannot serve a lookup by
 * `(store_id, register_id)`: the engine reads an index left to right, so the first column has to
 * be the first column. Comparing the two as sets — or, worse, as their names joined together —
 * would call that covered, and the mistake it would then miss is the common one.
 */
export function isLeftPrefix(wanted: readonly string[], columns: readonly string[]): boolean {
  if (wanted.length > columns.length) return false;
  return wanted.every((name, i) => columns[i]!.toLowerCase() === name.toLowerCase());
}

/** Clauses that end a `WHERE`, and after which an equality is no longer part of it. */
const WHERE_BOUNDARY: ReadonlySet<string> = new Set(["GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTO"]);

/**
 * The columns a `WHERE` fixes to a single value.
 *
 * Two rules ask this and they had better agree: one wants to know whether the clause finishes a
 * composite key a join only half fixed, the other whether a subquery is a lookup of one row rather
 * than a search that may find none. Both questions are "what does this clause pin down", and a
 * second copy of the answer would drift.
 *
 * Only equalities at the clause's own depth, and only when no `OR` shares that depth: `a = 1 AND b =
 * 2 OR c` does not fix anything, and telling the difference for real is a parse this backend does
 * not do. What is on the other side of the `=` is not examined, because it does not matter — a
 * parameter, a literal or another relation's column all hold still while the table is scanned.
 *
 * `col IN (SELECT MAX(col) …)` counts too, and has to. A subquery that folds to one row or takes
 * `LIMIT 1` yields one value, so `IN` over it is the `=` written another way — and it is how the
 * latest row per group is spelled. Reading only `=` would let the same predicate pin a key or not
 * depending on which spelling the author reached for. A list of literals, or a subquery free to
 * return several, is left alone: there, more than one value is what `IN` is for.
 *
 * References qualified by `label` always count. Bare names count only when `bare` says so — a caller
 * reading one relation's `WHERE` out of a join cannot tell whose column an unqualified name is,
 * while a caller looking at a query over a single table has nothing else it could belong to.
 */
export function pinnedByWhere(
  tokens: readonly Token[],
  scope: { from: number; to: number },
  fold: (name: string) => string,
  label?: string,
  bare = false,
): string[] {
  let where = -1;
  let depth = 0;
  for (let i = scope.from; i <= scope.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "WHERE")) {
      where = i;
      break;
    }
  }
  if (where === -1) return [];

  const columns: string[] = [];

  /**
   * Records the column an operand names, given where a qualified `t.col` would start and where a
   * bare `col` would sit — the two spellings land at different offsets from the operator.
   */
  const operand = (qualified: number, plain: number): void => {
    if (tokens[qualified]?.t === "id" && punct(tokens[qualified + 1], ".") && tokens[qualified + 2]?.t === "id") {
      if (fold(tokens[qualified]!.v) === label) columns.push(tokens[qualified + 2]!.v);
      return;
    }
    if (!bare) return;
    const name = tokens[plain];
    if (name?.t !== "id" || punct(tokens[plain - 1], ".") || punct(tokens[plain + 1], ".")) return;
    columns.push(name.v);
  };

  depth = 0;
  for (let i = where + 1; i <= scope.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && kw(t, "OR")) {
      return [];
    } else if (depth === 0 && (kwAny(t, WHERE_BOUNDARY) !== undefined || punct(t, ";"))) {
      break;
    } else if (depth === 0 && punct(t, "=")) {
      operand(i - 3, i - 1);
      operand(i + 1, i + 1);
    } else if (depth === 0 && kw(t, "IN") && punct(tokens[i + 1], "(") && kw(tokens[i + 2], "SELECT")) {
      const close = matchingParen(tokens, i + 1);
      if (close === -1) break;
      // One value on the right is an `=` however it is spelled; several is what `IN` is normally for.
      if (foldsToOneRow(tokens, i + 3, close - 1) || limitsToOne(tokens, i + 3, close - 1)) operand(i - 3, i - 1);
    }
  }
  return columns;
}

/**
 * Do these columns pin the table to at most one row?
 *
 * The primary key or any unique index, wholly covered. Partly covered is not covered: half of a
 * two-column key identifies a group of rows, and a group is not a row.
 */
export function coversUniqueKey(
  fold: (name: string) => string,
  table: Table,
  columns: readonly string[],
): boolean {
  const fixed = new Set(columns.map(fold));
  const covered = (key: readonly string[]): boolean => key.length > 0 && key.every((name) => fixed.has(fold(name)));

  if (covered(table.primaryKey)) return true;
  return table.indexes.some((index) => index.unique && covered(index.columns));
}

/** One query over one table, with what its `WHERE` fixes — the shape a row can be looked up in. */
export interface SingleTableQuery {
  table: Table;
  /** The columns the `WHERE` fixes to one value. */
  pinned: string[];
}

/**
 * The one table a scalar subquery reads, and what its `WHERE` pins down — or `undefined` when there
 * is more than one table, or none the catalog knows.
 *
 * A join disqualifies it whatever the `WHERE` pins, because the second table decides on its own how
 * many rows come back: none, if it matches nothing, and several, if it matches several. Both are
 * what the callers of this are trying to rule out.
 */
export function singleTableQuery(
  ctx: ScopedContext,
  sel: number,
  close: number,
): SingleTableQuery | undefined {
  const scope = ctx.scopeAt(sel);
  if (!scope || scope.to > close) return undefined;

  const only = scope.relations.length === 1 ? scope.relations[0] : undefined;
  if (!only?.name || only.cte || only.derived) return undefined;

  const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
  const table = ctx.catalog.table(only.name);
  if (!table) return undefined;

  // Filtered to columns the table actually has: an unqualified `=` reads both sides, and the other
  // one is normally a parameter or a literal that only looks like a name.
  const pinned = pinnedByWhere(ctx.tokens, scope, fold, fold(only.alias ?? only.name), true).filter((name) =>
    table.byName.has(fold(name)),
  );
  return { table, pinned };
}

/**
 * One equality an `ON`/`USING` condition asserts, as read off the tokens rather than resolved yet
 * against either side of the join: `qualifier` is empty for a `USING (col)` name, which stands for
 * both tables at once.
 */
interface JoinEquality {
  a: { qualifier: string; column: string };
  b: { qualifier: string; column: string };
}

/** What `USING`/`ON` say about a join to one relation, or `undefined` when there is nothing to read. */
interface JoinCondition {
  using: boolean;
  equalities: readonly JoinEquality[];
}

type JoinKind = "base" | "comma" | "cross" | "right" | "left" | "inner";

/** Keywords that end a join condition or a `FROM` clause's own list of relations. */
const JOIN_CLAUSE_BOUNDARY: ReadonlySet<string> = new Set([
  "JOIN",
  "STRAIGHT_JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "CROSS",
  "FULL",
  "NATURAL",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "SET",
  "UNION",
  "INTO",
]);

/** The token index whose own span starts exactly at `offset`, within `[from, to]`, or `-1`. */
function indexAtOffset(tokens: readonly Token[], from: number, to: number, offset: number): number {
  for (let i = from; i <= to; i++) if (tokens[i]!.s === offset) return i;
  return -1;
}

/** Reads a qualified `id . id` starting at `base`, or `undefined` when that is not what is there. */
function qualifiedAt(tokens: readonly Token[], base: number): { qualifier: string; column: string } | undefined {
  const q = tokens[base];
  if (q?.t !== "id" || !punct(tokens[base + 1], ".") || tokens[base + 2]?.t !== "id") return undefined;
  return { qualifier: q.v, column: tokens[base + 2]!.v };
}

/**
 * The `qualifier.column = qualifier.column` equalities an `ON` condition asserts at its own depth.
 *
 * A top-level `OR` makes the whole condition unreadable as a set of equalities — the same reason
 * `pinnedByWhere` stands down on one — so it comes back empty rather than guessing which half holds.
 * Anything that is not a qualified equality (a literal comparison, a function call) is passed over
 * rather than failing the whole read: an extra predicate only narrows what the join can match.
 */
function equalitiesIn(tokens: readonly Token[], from: number, to: number): JoinEquality[] {
  const pairs: JoinEquality[] = [];
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (kw(t, "OR")) return [];
    if (punct(t, "=")) {
      const a = qualifiedAt(tokens, i - 3);
      const b = qualifiedAt(tokens, i + 1);
      if (a && b) pairs.push({ a, b });
    }
  }
  return pairs;
}

/** Where the condition after an `ON` ends: the next join keyword, clause boundary, or `;`. */
function conditionEnd(tokens: readonly Token[], from: number, to: number): number {
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (kwAny(t, JOIN_CLAUSE_BOUNDARY) !== undefined || punct(t, ";")) return i - 1;
  }
  return to;
}

/**
 * How `rel` entered the scope — a comma, a plain `JOIN`, a `LEFT`/`RIGHT`/`CROSS` one, or the first
 * relation after `FROM` — and what its own `ON`/`USING` says, read straight from the tokens: neither
 * is on `Relation` itself, and re-deriving them here is cheaper than widening that model for the one
 * caller that needs them.
 */
function joinInfo(tokens: readonly Token[], scope: { from: number; to: number }, rel: Relation): {
  kind: JoinKind;
  condition?: JoinCondition;
} {
  const nameIdx = indexAtOffset(tokens, scope.from, scope.to, rel.offset);
  if (nameIdx === -1) return { kind: "comma" };

  // Step back over an explicit schema: `db . table`.
  let k = nameIdx;
  if (punct(tokens[k - 1], ".") && tokens[k - 2]?.t === "id") k -= 2;
  const before = tokens[k - 1];

  let kind: JoinKind;
  if (kw(before, "FROM")) kind = "base";
  else if (punct(before, ",")) kind = "comma";
  else if (kw(before, "STRAIGHT_JOIN")) kind = "inner";
  else if (kw(before, "JOIN")) {
    let m = k - 2;
    if (kw(tokens[m], "OUTER")) m--;
    if (kw(tokens[m], "LEFT")) kind = "left";
    else if (kw(tokens[m], "RIGHT")) kind = "right";
    else if (kw(tokens[m], "CROSS") || kw(tokens[m], "NATURAL")) kind = "cross";
    else kind = "inner";
  } else return { kind: "comma" }; // Not a shape this reads; treated the same as no condition at all.

  if (kind === "base" || kind === "comma" || kind === "cross" || kind === "right") return { kind };

  // Past the optional alias, to reach `ON`/`USING`.
  let j = nameIdx + 1;
  if (kw(tokens[j], "AS")) j++;
  if (tokens[j]?.t === "id" && kwAny(tokens[j], JOIN_CLAUSE_BOUNDARY) === undefined) j++;

  if (kw(tokens[j], "USING") && punct(tokens[j + 1], "(")) {
    const close = matchingParen(tokens, j + 1);
    if (close === -1) return { kind };
    const equalities: JoinEquality[] = [];
    for (const span of splitCommas(tokens, j + 2, close - 1)) {
      if (span.from !== span.to || tokens[span.from]?.t !== "id") continue;
      const column = tokens[span.from]!.v;
      equalities.push({ a: { qualifier: "", column }, b: { qualifier: "", column } });
    }
    return { kind, condition: { using: true, equalities } };
  }

  if (kw(tokens[j], "ON")) {
    const end = conditionEnd(tokens, j + 1, scope.to);
    return { kind, condition: { using: false, equalities: equalitiesIn(tokens, j + 1, end) } };
  }

  return { kind };
}

/**
 * Is `rel` joined to `anchor` in a way that can add at most the one row a foreign key guarantees,
 * and — for anything but a `LEFT JOIN` — never removes `anchor`'s own?
 *
 * The join's own `USING`/`ON` — `USING (col)` reads as both tables holding that column, `ON` reads
 * only its `qualifier.column = qualifier.column` equalities, in either orientation — has to equate a
 * column of `anchor` with **all** of `rel`'s primary key, and `anchor` has to declare a `FOREIGN KEY`
 * on exactly that column referencing `rel`'s primary key. Outside a `LEFT JOIN`, that column also has
 * to be `NOT NULL`: an `INNER JOIN` drops `anchor`'s row when it is NULL, which is a claim about the
 * data rather than the schema; a `LEFT JOIN` never drops it either way.
 *
 * Only one level: a table joined to `rel` rather than to `anchor` is a chain, and chains are not
 * read here — this asks only about `rel` and `anchor`, which is what keeps it simple.
 */
function isToOneJoin(
  fold: (name: string) => string,
  tokens: readonly Token[],
  scope: { from: number; to: number },
  anchor: Relation,
  anchorTable: Table,
  rel: Relation,
  relTable: Table,
): boolean {
  const info = joinInfo(tokens, scope, rel);
  if (info.kind !== "inner" && info.kind !== "left") return false;
  if (!info.condition || info.condition.equalities.length === 0) return false;

  const anchorLabel = fold(anchor.alias ?? anchor.name!);
  const relLabel = fold(rel.alias ?? rel.name!);

  const relCols = new Set<string>();
  // `rel`'s folded column -> the `anchor` column it is equated with.
  const byRelColumn = new Map<string, string>();

  for (const { a, b } of info.condition.equalities) {
    if (!a.qualifier && !b.qualifier) {
      // A `USING (col)` name: the same column, read on both sides.
      const col = fold(a.column);
      relCols.add(col);
      byRelColumn.set(col, col);
      continue;
    }
    const aAnchor = fold(a.qualifier) === anchorLabel;
    const aRel = fold(a.qualifier) === relLabel;
    const bAnchor = fold(b.qualifier) === anchorLabel;
    const bRel = fold(b.qualifier) === relLabel;

    if (aAnchor && bRel) {
      relCols.add(fold(b.column));
      byRelColumn.set(fold(b.column), fold(a.column));
    } else if (bAnchor && aRel) {
      relCols.add(fold(a.column));
      byRelColumn.set(fold(a.column), fold(b.column));
    }
    // A qualifier that names neither table — a self-join alias, or an equality against a literal
    // that happened to parse the same way — says nothing about the two tables and is left out.
  }

  const relKey = relTable.primaryKey.map(fold);
  if (relKey.length === 0 || !relKey.every((col) => relCols.has(col))) return false;

  const anchorSide = relKey.map((col) => byRelColumn.get(col));
  if (anchorSide.some((col) => col === undefined)) return false;
  const anchorSideSet = new Set(anchorSide as string[]);

  const fk = anchorTable.foreignKeys.find((candidate) => {
    if (candidate.refTable === undefined || fold(candidate.refTable) !== fold(rel.name!)) return false;
    if (candidate.columns.length !== anchorSideSet.size) return false;
    if (!candidate.columns.every((c) => anchorSideSet.has(fold(c)))) return false;
    const refCols = candidate.refColumns.map(fold);
    return refCols.length === relKey.length && relKey.every((c) => refCols.includes(c));
  });
  if (!fk) return false;

  if (info.kind === "left") return true;
  // An `INNER JOIN`: the row only survives when the column that points at it cannot be NULL.
  return fk.columns.every((c) => anchorTable.byName.get(fold(c))?.nullable === false);
}

/**
 * The join-aware half of `isKeyLookup`: a scope with more than one relation, where exactly one of
 * them — the anchor — has its own whole primary key or unique index pinned by the `WHERE`, and every
 * other relation reaches it by a to-one join (`isToOneJoin`). `singleTableQuery` already covers the
 * one-relation case; this is what a join adds to it.
 */
function isToOneJoinLookup(ctx: ScopedContext, sel: number, close: number): boolean {
  const scope = ctx.scopeAt(sel);
  if (!scope || scope.to > close || scope.relations.length < 2) return false;

  const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);

  const tables = new Map<Relation, Table>();
  for (const rel of scope.relations) {
    if (!rel.name || rel.cte || rel.derived) return false;
    const table = ctx.catalog.table(rel.name);
    if (!table) return false;
    tables.set(rel, table);
  }

  let anchor: Relation | undefined;
  for (const rel of scope.relations) {
    const table = tables.get(rel)!;
    const label = fold(rel.alias ?? rel.name!);
    const pinned = pinnedByWhere(ctx.tokens, scope, fold, label, false).filter((name) =>
      table.byName.has(fold(name)),
    );
    if (coversUniqueKey(fold, table, pinned)) {
      if (anchor) return false; // More than one candidate: which row is being looked up is ambiguous.
      anchor = rel;
    }
  }
  if (!anchor) return false;
  const anchorTable = tables.get(anchor)!;

  for (const rel of scope.relations) {
    if (rel === anchor) continue;
    if (!isToOneJoin(fold, ctx.tokens, scope, anchor, anchorTable, rel, tables.get(rel)!)) return false;
  }
  return true;
}

/**
 * Is this subquery a **lookup** of a row rather than a search that may find none?
 *
 * One table, and a `WHERE` that fixes a whole primary key or unique index of it: `SELECT Valor FROM
 * Settings WHERE Parameter = 'X'` is somebody reading a row they know is there, and telling them it
 * might not be is a claim about their data rather than about their query. A search — a range of
 * dates, a status that is not one value, a join to another table — is the opposite: finding nothing
 * is one of its ordinary outcomes.
 *
 * **A join is not automatically a search.** A join to another table through a `NOT NULL` foreign key
 * onto that table's whole primary key keeps it a lookup: the schema itself guarantees the joined row
 * is there, which is exactly the guarantee a `WHERE` on one table's own key makes. A join the catalog
 * cannot vouch for — no declared foreign key, a nullable foreign key column joined with `INNER`, a
 * join to a column that is not the other table's key — is still a search, for the same reason a
 * search of one table is: nothing says the row is there.
 *
 * The catalog is what tells the two apart, and nothing else can: the same `WHERE` shape is a lookup
 * against one table and a search against another, and only the keys say which.
 */
export function isKeyLookup(ctx: ScopedContext, sel: number, close: number): boolean {
  const query = singleTableQuery(ctx, sel, close);
  if (query) return coversUniqueKey((name) => ctx.dialect.foldIdentifier(name, false), query.table, query.pinned);
  return isToOneJoinLookup(ctx, sel, close);
}
