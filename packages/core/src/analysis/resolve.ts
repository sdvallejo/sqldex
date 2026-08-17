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

export type ResolvedKind = "table" | "temp_table" | "derived";

export interface Resolved {
  kind: ResolvedKind;
  /** The catalog definition, when it is a real table. */
  table?: Table;
  /** Column names, when it is temporary. */
  columns?: string[];
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
): Resolved | undefined {
  const key = ctx.dialect.foldIdentifier(name, false);

  if ((key === "new" || key === "old") && scope.triggerTable !== undefined) {
    const table = ctx.catalog.table(scope.triggerTable);
    if (table) return { kind: "table", table, name: table.name };
  }

  const relation = analysis.byAlias.get(key);
  if (relation) {
    if (!relation.name || relation.cte || foreignSchema(ctx, relation)) {
      return { kind: "derived", name };
    }
    return named(ctx, scope, relation.name);
  }

  return named(ctx, scope, name);
}

/** Resolves a `FROM` relation to its definition. */
export function relation(ctx: ResolveContext, scope: Locals, item: Relation): Resolved | undefined {
  // A common table expression is a relation whose columns come out of its own query, and a
  // foreign schema's is a relation this repo cannot see: both have a name and neither has columns
  // anybody here can assert, which is exactly what `derived` means.
  if (!item.name || item.cte || foreignSchema(ctx, item)) {
    return { kind: "derived", name: item.alias ?? item.name ?? "?" };
  }
  return named(ctx, scope, item.name);
}

/** Column names of something already resolved. */
export function columnNames(resolved: Resolved | undefined): string[] {
  if (!resolved) return [];
  if (resolved.kind === "temp_table") return resolved.columns ?? [];
  if (resolved.table) return resolved.table.columns.map((column) => column.name);
  return [];
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
