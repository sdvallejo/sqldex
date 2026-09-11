/**
 * `inferVariableType`: what a `DECLARE` would say, read back from how a name is already assigned.
 *
 * One test per shape the `CAST`/`CONVERT` mapping distinguishes, plus the other two sources a write
 * can offer — a catalog column, a bare local — and the two ways an answer is refused: nothing
 * inferrable, or two writes that disagree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { inferVariableType } from "../src/analysis/variable-type.ts";
import type { CatalogLookup } from "../src/catalog/catalog.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Local, Locals } from "../src/model/locals.ts";
import type { Table } from "../src/model/table.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

const SCHEMA = [
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  label varchar(40) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
].join("\n");

function catalogOf(): CatalogLookup {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, SCHEMA, tokenize(SCHEMA)).tables) tables.set(table.name.toLowerCase(), table);
  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: () => undefined,
  };
}

const EMPTY_LOCALS: Locals = { items: [], byName: new Map() };

/** A `Locals` with a single item, the way `analysis/locals.ts` would have collected it. */
function localsOf(item: Local): Locals {
  return { items: [item], byName: new Map([[item.name.toLowerCase(), item]]) };
}

function inferOf(body: string, name: string, locals: Locals = EMPTY_LOCALS): ReturnType<typeof inferVariableType> {
  const src = `CREATE PROCEDURE sp_x() BEGIN\n${body}\nEND;`;
  const tokens = tokenize(src).tokens;
  const beginIdx = tokens.findIndex((t) => t.t === "id" && t.v.toUpperCase() === "BEGIN");
  return inferVariableType(
    { dialect: mysql, catalog: catalogOf(), src, tokens, locals },
    name,
    { from: beginIdx + 1, to: tokens.length - 1 },
  );
}

// -------------------------------------------------------------- the CAST/CONVERT mapping

test("SIGNED becomes BIGINT, the widest signed value the cast could ever produce", () => {
  const type = inferOf("SET v = CAST(1 AS SIGNED);", "v");
  assert.equal(type?.name, "bigint");
  assert.equal(type?.unsigned ?? false, false);
});

test("UNSIGNED becomes BIGINT UNSIGNED, read through CONVERT's two-argument form too", () => {
  const type = inferOf("SET v = CONVERT(label, UNSIGNED);", "v");
  assert.equal(type?.name, "bigint");
  assert.equal(type?.unsigned, true);
});

test("DECIMAL, with or without precision, carries straight through", () => {
  assert.equal(inferOf("SET v = CAST(1 AS DECIMAL);", "v")?.raw, "DECIMAL");
  assert.equal(inferOf("SET v = CAST(1 AS DECIMAL(10,2));", "v")?.raw, "DECIMAL(10,2)");
});

test("CHAR(N) becomes VARCHAR(N)", () => {
  const type = inferOf("SET v = CAST(label AS CHAR(5));", "v");
  assert.equal(type?.name, "varchar");
  assert.deepEqual(type?.args, ["5"]);
});

test("CHAR without a length is the trap: DECLARE would make it CHAR(1), so it is left undefined", () => {
  assert.equal(inferOf("SET v = CAST(label AS CHAR);", "v"), undefined);
});

test("BINARY(N) becomes VARBINARY(N)", () => {
  const type = inferOf("SET v = CAST(label AS BINARY(3));", "v");
  assert.equal(type?.name, "varbinary");
  assert.deepEqual(type?.args, ["3"]);
});

test("BINARY without a length is undefined for the same reason CHAR is", () => {
  assert.equal(inferOf("SET v = CAST(label AS BINARY);", "v"), undefined);
});

test("DATE, DATETIME, TIME, JSON, DOUBLE, FLOAT, REAL and YEAR all carry straight through", () => {
  assert.equal(inferOf("SET v = CAST('2020-01-01' AS DATE);", "v")?.name, "date");
  assert.equal(inferOf("SET v = CAST('2020-01-01' AS DATETIME(3));", "v")?.raw, "DATETIME(3)");
  assert.equal(inferOf("SET v = CAST('10:00' AS TIME);", "v")?.name, "time");
  assert.equal(inferOf("SET v = CAST('{}' AS JSON);", "v")?.name, "json");
  assert.equal(inferOf("SET v = CAST(1 AS DOUBLE);", "v")?.name, "double");
  assert.equal(inferOf("SET v = CAST(1 AS FLOAT);", "v")?.name, "float");
  assert.equal(inferOf("SET v = CAST(1 AS REAL);", "v")?.name, "real");
  assert.equal(inferOf("SET v = CAST(1 AS YEAR);", "v")?.name, "year");
});

test("NCHAR, and anything else the mapping does not name, is undefined", () => {
  assert.equal(inferOf("SET v = CAST(label AS NCHAR);", "v"), undefined);
});

// ------------------------------------------------------------------------- the other sources

test("a scalar subquery's single item is read the same two ways a SELECT ... INTO's is", () => {
  const type = inferOf("SET v = (SELECT customer_id FROM customers WHERE customer_id = 1);", "v");
  assert.equal(type?.name, "int");
});

test("a bare/qualified column of a resolved table is that column's own type", () => {
  const type = inferOf("SELECT c.customer_id INTO v FROM customers c;", "v");
  assert.equal(type?.name, "int");
});

test("a SELECT ... INTO inside an IF branch is read the same as one that opens the body", () => {
  const type = inferOf("IF 1 = 1 THEN SELECT c.customer_id INTO v FROM customers c; END IF;", "v");
  assert.equal(type?.name, "int");
});

test("a bare local or parameter that already has a type carries it over", () => {
  const param: Local = { name: "p_id", quoted: false, kind: "param", type: { name: "int", args: [], raw: "int" }, nameSpan: { s: 0, e: 0 } };
  const type = inferOf("SET v = p_id;", "v", localsOf(param));
  assert.equal(type?.name, "int");
});

// ----------------------------------------------------------------------------- refusing a guess

test("a write that fits none of the sources is skipped, not counted against the others", () => {
  const type = inferOf("SET v = 1 + 1;", "v");
  assert.equal(type, undefined);
});

test("two writes that disagree give up on the whole answer", () => {
  const type = inferOf("SET v = CAST(1 AS SIGNED); SET v = CAST(label AS CHAR(5));", "v");
  assert.equal(type, undefined);
});

test("two writes that agree, even by two different routes, still answer", () => {
  const type = inferOf(
    "SET v = CAST(1 AS SIGNED); SELECT CONVERT(label, SIGNED) INTO v FROM customers;",
    "v",
  );
  assert.equal(type?.name, "bigint");
});
