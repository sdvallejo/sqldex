/**
 * The per-file catalog layer, which is what makes a migration script checkable.
 *
 * The whole point is a shape the rest of the suite never produces: a file that both **declares** a
 * table and **uses** it, a few statements apart, while the project catalog knows nothing about it.
 * Every case here is that shape or its control.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withOwnDefinitions } from "../src/catalog/overlay.ts";
import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import { columnTypeCensus } from "../src/catalog/catalog.ts";
import type { RuleCatalog } from "../src/rules/rule.ts";
import { allRules } from "../src/rules/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

/** The project's own tables — everything the migration is *not* allowed to have introduced. */
const PROJECT = [
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  email varchar(120) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
].join("\n");

function projectCatalog(schema: string): RuleCatalog {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, schema, tokenize(schema)).tables) {
    if (!table.temporary) tables.set(table.name.toLowerCase(), table);
  }
  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: () => undefined,
    tables,
    index: (_key, build) => build(tables),
  };
}

/** Every message the full registry produces for `src`, with and without the layer. */
function messages(src: string, layered: boolean, schema = PROJECT): string[] {
  const base = projectCatalog(schema);
  const lexed = tokenize(src);
  const catalog = layered ? withOwnDefinitions(base, mysql, src, lexed) : base;
  return check(
    allRules(),
    { dialect: mysql, catalog, schemas: new Set(["shop"]), config: defaults },
    src,
  ).map((d) => d.message);
}

// ------------------------------------------------------- the shape it exists for

/**
 * The witness, reduced from a real deploy script: a `CREATE TABLE` and then nine `INSERT`s into it
 * over the next hundred lines. Without the layer, every one of those is an unknown table.
 */
const CREATES_AND_USES = [
  "CREATE TABLE rejection_reasons (",
  "  reason_id int NOT NULL,",
  "  label varchar(60) NOT NULL,",
  "  PRIMARY KEY (reason_id)",
  ");",
  "INSERT INTO rejection_reasons (reason_id, label) VALUES (1, 'expired');",
  "INSERT INTO rejection_reasons (reason_id, label) VALUES (2, 'duplicate');",
].join("\n");

test("a table the file itself creates is not an unknown table", () => {
  assert.deepEqual(messages(CREATES_AND_USES, true), []);
});

test("without the layer, the same file reports its own table as unknown", () => {
  // The control for the case above: it is only worth layering if this is what happens otherwise.
  const without = messages(CREATES_AND_USES, false);
  assert.equal(without.length, 2);
  assert.ok(without.every((m) => m === "unknown table: rejection_reasons"));
});

test("the layer knows the columns, not just the name", () => {
  // Resolving the name is half of it. A column the file's own `CREATE TABLE` does not declare has
  // to still be reported, or the layer would be silencing by making the table opaque.
  const src = [
    "CREATE TABLE rejection_reasons (",
    "  reason_id int NOT NULL,",
    "  PRIMARY KEY (reason_id)",
    ");",
    "INSERT INTO rejection_reasons (reason_id, label) VALUES (1, 'expired');",
  ].join("\n");
  assert.deepEqual(messages(src, true), ["rejection_reasons has no column label"]);
});

// ------------------------------------------------------------------ guard pairs

test("a table nobody defines is still unknown", () => {
  // The guard pair for the first case. A layer that answered for every name would silence the
  // rule outright, and the file below is exactly the one that must keep sounding.
  const src = [
    "CREATE TABLE rejection_reasons (",
    "  reason_id int NOT NULL,",
    "  PRIMARY KEY (reason_id)",
    ");",
    "INSERT INTO shipping_zones (zone_id) VALUES (1);",
  ].join("\n");
  assert.deepEqual(messages(src, true), ["unknown table: shipping_zones"]);
});

test("a project table the file does not touch keeps its own columns", () => {
  const src = [
    "CREATE TABLE rejection_reasons (reason_id int NOT NULL, PRIMARY KEY (reason_id));",
    "INSERT INTO customers (customer_id, phone) VALUES (1, '555');",
  ].join("\n");
  assert.deepEqual(messages(src, true), ["customers has no column phone"]);
});

test("the file's own definition wins over the project's", () => {
  // A deploy script that redefines a table is describing what will be there when it has run, and
  // that is the shape its own statements have to be read against.
  const src = [
    "CREATE TABLE customers (",
    "  customer_id int NOT NULL,",
    "  email varchar(120) NOT NULL,",
    "  phone varchar(30) NOT NULL,",
    "  PRIMARY KEY (customer_id)",
    ");",
    "INSERT INTO customers (customer_id, phone) VALUES (1, '555');",
  ].join("\n");
  assert.deepEqual(messages(src, true), []);
  assert.deepEqual(messages(src, false), ["customers has no column phone"]);
});

test("a temporary table is not layered on", () => {
  // It is a local of the routine that made it, and `locals` already answers for it with more than
  // a name. Two mechanisms answering the same question is how they come to disagree.
  const src = [
    "CREATE PROCEDURE p()",
    "BEGIN",
    "  CREATE TEMPORARY TABLE tmp_totals (customer_id int NOT NULL);",
    "  INSERT INTO tmp_totals (customer_id) VALUES (1);",
    "END;",
  ].join("\n");
  const layered = withOwnDefinitions(projectCatalog(PROJECT), mysql, src, tokenize(src));
  assert.equal(layered.table("tmp_totals"), undefined);
});

// ------------------------------------------------------------ what it must not do

test("the type census is the project's, unmoved by the file", () => {
  // `schema/divergent-type` asks "in how many of the tables that have this column", and a
  // migration is not one more table in that count.
  const schema = [
    PROJECT,
    "CREATE TABLE orders (order_id int NOT NULL, email varchar(120) NOT NULL);",
  ].join("\n");
  const base = projectCatalog(schema);
  const src = "CREATE TABLE staging_customers (customer_id int NOT NULL, email text NOT NULL);";
  const layered = withOwnDefinitions(base, mysql, src, tokenize(src));

  const census = (catalog: RuleCatalog): Map<string, number> | undefined =>
    catalog.index("column-types", (tables) => columnTypeCensus(mysql, tables)).get("email");
  assert.deepEqual(census(layered), census(base));
});

test("a file that declares nothing is handed the catalog itself", () => {
  const base = projectCatalog(PROJECT);
  const src = "SELECT customer_id FROM customers;";
  assert.equal(withOwnDefinitions(base, mysql, src, tokenize(src)), base);
});

test("routines and triggers are still the project's to answer for", () => {
  const src = "CREATE TABLE rejection_reasons (reason_id int NOT NULL);";
  const base = projectCatalog(PROJECT);
  const layered = withOwnDefinitions(base, mysql, src, tokenize(src));
  assert.equal(layered.routine("sp_anything"), undefined);
  assert.equal(layered.trigger("t_anything"), undefined);
  assert.equal(layered.tempTable("tmp_anything"), undefined);
});
