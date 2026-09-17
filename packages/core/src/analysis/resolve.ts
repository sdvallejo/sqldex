/**
 * Resolves names to catalog objects, according to what the statement and the file say.
 *
 * Completion, goto-definition, hover and the diagnostics all share it: they all start from the
 * same question — "this `o` here, what is it?" — and they had better answer it the same way.
 *
 * It depends on `CatalogLookup`, never on `Catalog`. Name resolution is a question *about* a
 * catalog, not about how one was built, and a rule's test wants to hand it a catalog assembled by
 * hand rather than a directory of files.
 */

import type { CatalogLookup, TempTableEntry } from "../catalog/catalog.ts";
import type { Dialect } from "../dialects/dialect.ts";
import type { Local, Locals } from "../model/locals.ts";
import type { Relation } from "../model/query.ts";
import type { Table } from "../model/table.ts";
import type { Analysis } from "../syntax/fast/cursor.ts";
import type { Lexed, Token } from "../syntax/types.ts";
import { derivedColumns, type ResolvedSelect } from "./locals.ts";

export type ResolvedKind = "table" | "temp_table" | "derived";

export interface Resolved {
  kind: ResolvedKind;
  /** The catalog definition, when it is a real table. */
  table?: Table;
  /** Column names, when it is temporary or, given the tokens, derived. */
  columns?: string[];
  /**
   * Whether `columns` is the whole answer. Only set for `derived`: a temporary table's `columns`
   * has always been a best effort, but a derived table's completeness is exactly what tells
   * `names/unknown-column` whether a name missing from `columns` is worth reporting or just
   * something this pass could not follow.
   */
  complete?: boolean;
  name: string;
}

/**
 * Everything resolution needs to know about where it is standing.
 *
 * `schemas` is the set the project declares, folded. It is passed in rather than read from the
 * config here so that this module stays free of I/O.
 */
export interface ResolveContext {
  dialect: Dialect;
  catalog: CatalogLookup;
  schemas: ReadonlySet<string>;
}

/**
 * How many levels a chain of `SELECT *` between temporary tables is followed. One temporary
 * copying another that copies another is normal; deeper than this is a broken chain or a cycle.
 */
const MAX_STAR_DEPTH = 4;

/** The shape both a file-local temporary table and a catalogued one satisfy. */
type TempColumns = Pick<TempTableEntry, "columns" | "sources">;

/**
 * A temporary table's columns, expanding the `SELECT *` that feed it.
 *
 * A temporary table may declare its columns, or inherit them from a `SELECT * FROM other`. That
 * "other" may be a catalog table or even another temporary one, so the expansion is recursive and
 * bounded.
 */
function expandTempColumns(ctx: ResolveContext, item: TempColumns, depth = 0): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (name: string | undefined): void => {
    if (name === undefined) return;
    const key = ctx.dialect.foldIdentifier(name, false);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  for (const name of item.columns ?? []) push(name);

  if (depth >= MAX_STAR_DEPTH) return names;

  for (const source of item.sources ?? []) {
    const table = ctx.catalog.table(source);
    if (table) {
      for (const column of table.columns) push(column.name);
    } else {
      const temp = ctx.catalog.tempTable(source);
      if (temp) for (const name of expandTempColumns(ctx, temp, depth + 1)) push(name);
    }
  }

  return names;
}

/**
 * Resolves a temporary table wherever it lives: the file being looked at first, and failing that,
 * the project file that creates it.
 */
export function tempTable(ctx: ResolveContext, scope: Locals, name: string): Resolved | undefined {
  const item: Local | undefined = scope.byName.get(ctx.dialect.foldIdentifier(name, false));
  if (item && item.kind === "temp_table") {
    return { kind: "temp_table", columns: expandTempColumns(ctx, item), name: item.name };
  }

  const entry = ctx.catalog.tempTable(name);
  if (entry) return { kind: "temp_table", columns: expandTempColumns(ctx, entry), name: entry.name };
  return undefined;
}

/**
 * A derived table's columns, given the tokens: `derivedColumns` reads the subquery, and this
 * expands whatever its `*` selected from, resolved the way any `FROM` name is — the file's own
 * temporary tables first, then the catalog.
 *
 * Only a catalog table keeps the answer complete. A temporary table's columns are a best effort
 * (a `CREATE TEMPORARY TABLE ... SELECT` may not have been inferable, and one with the same name
 * in another file may not be this one), so its names are offered but the list stops being
 * something a missing name can be reported against. A source nothing resolves does the same.
 */
function expandDerivedColumns(
  ctx: ResolveContext,
  scope: Locals,
  derived: ResolvedSelect,
): { names: string[]; complete: boolean } {
  const names: string[] = [];
  const seen = new Set<string>();

  const push = (name: string): void => {
    const key = ctx.dialect.foldIdentifier(name, false);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  for (const name of derived.names) push(name);

  let complete = derived.complete;
  for (const source of derived.sources) {
    const resolved = named(ctx, scope, source);
    if (resolved?.kind !== "table") complete = false;
    for (const name of columnNames(resolved)) push(name);
  }

  return { names, complete };
}

/** A `derived` result, with columns filled in from `tokens` when the relation is a real subquery. */
function resolvedDerived(
  ctx: ResolveContext,
  scope: Locals,
  item: Relation,
  name: string,
  tokens?: readonly Token[],
): Resolved {
  if (!item.name && tokens) {
    const found = derivedColumns(ctx.dialect, tokens, item);
    if (found) {
      const expanded = expandDerivedColumns(ctx, scope, found);
      return { kind: "derived", name, columns: expanded.names, complete: expanded.complete };
    }
  }
  return { kind: "derived", name };
}

/**
 * Does this reference name a database the repo does not define?
 *
 * `shop.orders` inside the `shop` repo is the table next door and resolves as usual;
 * `other.orders` is another database's, and the local `orders` says nothing about its columns.
 * Without this the alias of the foreign table got checked against the local definition, which is
 * how `o.external_order_id` — a column that exists, in the schema the repo does not hold — came out
 * as a missing column.
 */
export function foreignSchema(ctx: ResolveContext, relation: Relation): boolean {
  if (!relation.schema || ctx.schemas.size === 0) return false;
  return !ctx.schemas.has(relation.schema.toLowerCase());
}

/** Shared tail of both resolvers: a temporary table, then the catalog, then nothing. */
function named(ctx: ResolveContext, scope: Locals, name: string): Resolved | undefined {
  const temp = tempTable(ctx, scope, name);
  if (temp) return temp;

  const table = ctx.catalog.table(name);
  if (table) return { kind: "table", table, name: table.name };
  return undefined;
}

/**
 * Resolves an `alias.` qualifier to whatever has columns.
 *
 * order matters: `NEW`/`OLD` first, because inside a trigger they are language words and could
 * not be an alias; then the statement's aliases, which shadow any catalog table of that name; and
 * only last the catalog, so that `shipments.status` works even if nobody put it in a `FROM`.
 */
export function qualifier(
  ctx: ResolveContext,
  analysis: Analysis,
  scope: Locals,
  name: string,
  tokens?: readonly Token[],
): Resolved | undefined {
  return qualifierIn(ctx, analysis.byAlias, scope, name, tokens);
}

/**
 * The same, against an alias map given directly.
 *
 * A caller that has the aliases but not a cursor `Analysis` — a diagnostic reading a reference
 * somewhere in the middle of a statement, rather than under a cursor — would otherwise have to
 * fabricate the rest of an `Analysis` to ask this question.
 *
 * @param tokens The statement's tokens, so a genuine subquery's columns can be read rather than
 * left empty. Optional: a caller that only needs to know *whether* something resolves, not to
 * *what columns*, has no reason to carry them.
 */
export function qualifierIn(
  ctx: ResolveContext,
  byAlias: ReadonlyMap<string, Relation>,
  scope: Locals,
  name: string,
  tokens?: readonly Token[],
): Resolved | undefined {
  const key = ctx.dialect.foldIdentifier(name, false);

  if ((key === "new" || key === "old") && scope.triggerTable !== undefined) {
    const table = ctx.catalog.table(scope.triggerTable);
    if (table) return { kind: "table", table, name: table.name };
  }

  const relation = byAlias.get(key);
  if (relation) {
    if (!relation.name || relation.cte || foreignSchema(ctx, relation)) {
      return resolvedDerived(ctx, scope, relation, name, tokens);
    }
    return named(ctx, scope, relation.name);
  }

  return named(ctx, scope, name);
}

/** Resolves a `FROM` relation to its definition. */
export function relation(
  ctx: ResolveContext,
  scope: Locals,
  item: Relation,
  tokens?: readonly Token[],
): Resolved | undefined {
  // A common table expression is a relation whose columns come out of its own query, and a
  // foreign schema's is a relation this repo cannot see: both have a name and neither has columns
  // anybody here can assert, which is exactly what `derived` means.
  if (!item.name || item.cte || foreignSchema(ctx, item)) {
    return resolvedDerived(ctx, scope, item, item.alias ?? item.name ?? "?", tokens);
  }
  return named(ctx, scope, item.name);
}

/** Column names of something already resolved. */
export function columnNames(resolved: Resolved | undefined): string[] {
  if (!resolved) return [];
  if (resolved.table) return resolved.table.columns.map((column) => column.name);
  return resolved.columns ?? [];
}

export interface IdentifierAt {
  token: Token;
  /** The alias or table written before the dot, when there was one. */
  qualifier?: string;
  /** The token's index, so what follows can be inspected. */
  idx: number;
}

/**
 * The identifier under an offset, with its qualifier if it has one.
 *
 * This is what goto-definition and hover need in order to know what the cursor is on: for a
 * `o.status` it returns `o` and `status` separately.
 */
export function identifierAt(lexed: Lexed, offset: number): IdentifierAt | undefined {
  const tokens = lexed.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.s > offset) break;
    // `t.e` is one past the last character, so an offset sitting exactly at it is already past
    // the token: `o.id|` is on `id`, and the cursor after a space no longer is.
    if (t.t === "id" && offset >= t.s && offset < t.e) {
      const before = tokens[i - 1];
      const qualifierToken = tokens[i - 2];
      if (before && before.t === "punct" && before.v === "." && qualifierToken && qualifierToken.t === "id") {
        return { token: t, qualifier: qualifierToken.v, idx: i };
      }
      return { token: t, idx: i };
    }
  }
  return undefined;
}
