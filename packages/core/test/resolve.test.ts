/**
 * Name resolution, against a catalog assembled by hand.
 *
 * That is the point of `resolve` depending on `CatalogLookup` and not on `Catalog`: these cases
 * are about what a name means, and building them out of a directory of files would bury the case
 * under fixtures. Whether a catalog built from a directory of files is right is a separate
 * question, and `catalog.ts` owns it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { collect } from "../src/analysis/locals.ts";
import { columnNames, identifierAt, qualifier, relation, type ResolveContext } from "../src/analysis/resolve.ts";
import type { CatalogLookup, TempTableEntry } from "../src/catalog/catalog.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Locals } from "../src/model/locals.ts";
import type { Table } from "../src/model/table.ts";
import { analyze } from "../src/syntax/fast/cursor.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";

/** A catalog holding exactly what a case needs, and nothing else. */
function catalogOf(ddl: string, tempTables: TempTableEntry[] = []): CatalogLookup {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, ddl, tokenize(ddl)).tables) {
    tables.set(table.name.toLowerCase(), table);
  }
  const temps = new Map(tempTables.map((entry) => [entry.name.toLowerCase(), entry]));
  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: (name) => (name === undefined ? undefined : temps.get(name.toLowerCase())),
  };
}

const SCHEMA =
  "CREATE TABLE customers (`user_id` int NOT NULL, `name` varchar(50) NOT NULL);\n" +
  "CREATE TABLE events (`event_id` int NOT NULL, `name` varchar(50) NOT NULL);";

const EMPTY_SCOPE: Locals = { items: [], byName: new Map() };

function contextFor(ddl: string, tempTables: TempTableEntry[] = []): ResolveContext {
  return { dialect: mysql, catalog: catalogOf(ddl, tempTables), schemas: new Set(["shop"]) };
}

/** Resolves the qualifier of `alias.` at the end of `sql`. */
function resolveQualifier(sql: string, alias: string, ctx: ResolveContext, scope = EMPTY_SCOPE) {
  const tokens = tokenize(sql).tokens;
  return qualifier(ctx, analyze(mysql, sql, tokens, sql.length), scope, alias);
}

test("an alias resolves to the table it stands for", () => {
  const ctx = contextFor(SCHEMA);
  const resolved = resolveQualifier("SELECT c. FROM customers c", "c", ctx);
  assert.equal(resolved?.kind, "table");
  assert.deepEqual(columnNames(resolved), ["user_id", "name"]);
});

test("a table name resolves even when nobody put it in a FROM", () => {
  const ctx = contextFor(SCHEMA);
  assert.equal(resolveQualifier("SELECT customers.", "customers", ctx)?.kind, "table");
});

test("a reference into a schema the repo does not define resolves to nothing knowable", () => {
  const ctx = contextFor(SCHEMA);
  // `shop.customers` is the table next door and resolves as usual…
  assert.equal(resolveQualifier("SELECT c. FROM shop.customers c", "c", ctx)?.kind, "table");
  // …while `other.customers` is another database's, and the local `customers` says nothing about it.
  const foreign = resolveQualifier("SELECT c. FROM other.customers c", "c", ctx);
  assert.equal(foreign?.kind, "derived");
  assert.deepEqual(columnNames(foreign), []);
});

test("a CTE is a relation with a name and no columns anybody here can assert", () => {
  const ctx = contextFor(SCHEMA);
  const sql = "WITH customers AS (SELECT 1 AS x) SELECT c. FROM customers c";
  const resolved = resolveQualifier(sql, "c", ctx);
  assert.equal(resolved?.kind, "derived", "the CTE shadows the catalog table of the same name");
});

test("NEW and OLD resolve against the trigger's table, ahead of any alias", () => {
  const ctx = contextFor(SCHEMA);
  const scope: Locals = { ...EMPTY_SCOPE, triggerTable: "customers" };
  const resolved = resolveQualifier("SELECT NEW. FROM events NEW", "NEW", ctx, scope);
  assert.equal(resolved?.table?.name, "customers");
});

test("a temporary table declared in this file beats the one in the catalog", () => {
  const ctx = contextFor(SCHEMA, [{ name: "tmp", file: "other.sql", columns: ["FromCatalog"] }]);
  const src = "CREATE PROCEDURE p()\nBEGIN\n  CREATE TEMPORARY TABLE tmp (Local int);\n  SELECT 1;\nEND;";
  const scope = collect(mysql, src, tokenize(src).tokens, src.length, parseHeader(src));

  const local = resolveQualifier("SELECT tmp.", "tmp", ctx, scope);
  assert.deepEqual(columnNames(local), ["Local"]);
  // With nothing local, the project-wide one answers.
  assert.deepEqual(columnNames(resolveQualifier("SELECT tmp.", "tmp", ctx)), ["FromCatalog"]);
});

test("a temporary table fed by SELECT * inherits the source's columns, without repeats", () => {
  const ctx = contextFor(SCHEMA, [
    { name: "tmp", file: "a.sql", columns: ["user_id"], sources: ["customers"] },
  ]);
  // `user_id` is declared and also comes from the source; it appears once.
  assert.deepEqual(columnNames(resolveQualifier("SELECT tmp.", "tmp", ctx)), ["user_id", "name"]);
});

test("a relation resolves the same way a qualifier does", () => {
  const ctx = contextFor(SCHEMA);
  const sql = "SELECT 1 FROM customers c";
  const tokens = tokenize(sql).tokens;
  const item = analyze(mysql, sql, tokens, sql.length).relations[0]!;
  assert.equal(relation(ctx, EMPTY_SCOPE, item)?.table?.name, "customers");
});

test("identifierAt separates the qualifier from the name, and stops at the token's end", () => {
  const sql = "SELECT o.status FROM x o";
  const lexed = tokenize(sql);
  const at = sql.indexOf("status");

  assert.deepEqual(
    { name: identifierAt(lexed, at)?.token.v, qualifier: identifierAt(lexed, at)?.qualifier },
    { name: "status", qualifier: "o" },
  );
  // Inside the last character, still the token.
  assert.equal(identifierAt(lexed, at + 5)?.token.v, "status");
  // One past it, no longer: unlike the completion cursor, this asks what you are *on*.
  assert.equal(identifierAt(lexed, at + 6)?.token.v, undefined);
});
