/**
 * What a cursor sweep over real files does not reach, for locals.
 *
 * Sampling thousands of cursor positions across a repo covers the common shapes well, but two
 * things never come up in it: the `aliasesOnly` mode of `selectListColumns`, which only the
 * diagnostics call, and `definedAt`, which is consumed inside the resolver and never surfaces at
 * a cursor position at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { collect, jsonTableColumns, selectListColumns } from "../src/analysis/locals.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";
import { relations } from "../src/syntax/fast/stmt.ts";

function selectOf(src: string, aliasesOnly?: boolean): ReturnType<typeof selectListColumns> {
  const tokens = tokenize(src).tokens;
  const idx = tokens.findIndex((t) => t.t === "id" && t.v.toUpperCase() === "SELECT");
  return selectListColumns(tokens, idx, tokens.length - 1, aliasesOnly);
}

/** The `JSON_TABLE(...)` relation of a query with exactly one derived table in its `FROM`. */
function jsonTableOf(src: string): ReturnType<typeof jsonTableColumns> {
  const tokens = tokenize(src).tokens;
  const found = relations(mysql, tokens, 0, tokens.length - 1);
  const relation = found.find((r) => r.derived !== undefined);
  assert.ok(relation, "no derived relation in the query");
  return jsonTableColumns(tokens, relation);
}

test("aliasesOnly keeps the names the SELECT defines and drops the ones it only reads", () => {
  const src = "SELECT Col, t.Otra, ROUND(a, 2) Total, b AS Alias FROM t";
  // Everything nameable, which is what completion wants.
  assert.deepEqual(selectOf(src).names, ["Col", "Otra", "Total", "Alias"]);
  // Only what the list itself brings into being, which is what the diagnostics want: `Col` and
  // `t.Otra` are references to columns that must already exist.
  assert.deepEqual(selectOf(src, true).names, ["Total", "Alias"]);
});

test("definedAt marks the token that names a result, not the one that reads a column", () => {
  const src = "SELECT DATE_FORMAT(t.started_at, '%d/%m/%Y') started_at FROM t";
  const tokens = tokenize(src).tokens;
  const { definedAt } = selectOf(src);
  // The same word appears twice; only the second one defines a name.
  const occurrences = tokens.flatMap((t, i) => (t.v === "started_at" ? [i] : []));
  assert.equal(occurrences.length, 2);
  assert.equal(definedAt.has(occurrences[0]!), false);
  assert.equal(definedAt.has(occurrences[1]!), true);
});

test("a literal closing an item is an alias, but a lone literal is a value", () => {
  assert.deepEqual(selectOf("SELECT ROUND(a + b, 2) 'TotalNC' FROM t").names, ["TotalNC"]);
  assert.deepEqual(selectOf("SELECT 'literal' FROM t").names, []);
});

test("a temporary table's columns come from its SELECT when it declares none", () => {
  const src =
    "CREATE PROCEDURE p(pA int)\nBEGIN\n" +
    "  DECLARE vX, vY DECIMAL(5,2) DEFAULT 0;\n" +
    "  DECLARE cur CURSOR FOR SELECT 1;\n" +
    "  CREATE TEMPORARY TABLE tmp SELECT Id, name FROM customers;\n" +
    "  SELECT 1;\n" +
    "END;";
  const tokens = tokenize(src).tokens;
  const locals = collect(mysql, src, tokens, src.length, parseHeader(src));

  assert.deepEqual(
    locals.items.map((i) => [i.name, i.kind]),
    [
      ["pA", "param"],
      ["vX", "variable"],
      ["vY", "variable"],
      ["cur", "cursor"],
      ["tmp", "temp_table"],
    ],
  );
  // Both names of a shared `DECLARE` get the same type, and the `DEFAULT` applies to both.
  assert.equal(locals.byName.get("vx")!.type!.raw, "DECIMAL(5,2)");
  assert.equal(locals.byName.get("vy")!.default, true);
  assert.deepEqual(locals.byName.get("tmp")!.columns, ["Id", "name"]);
});

test("only what is declared above the position is in scope", () => {
  const src = "CREATE PROCEDURE p()\nBEGIN\n  DECLARE vA int;\n  DECLARE vB int;\nEND;";
  const tokens = tokenize(src).tokens;
  const beforeB = src.indexOf("DECLARE vB");
  const names = collect(mysql, src, tokens, beforeB, parseHeader(src)).items.map((i) => i.name);
  assert.deepEqual(names, ["vA"]);
});

// ------------------------------------------------------------------ jsonTableColumns

test("jsonTableColumns reads FOR ORDINALITY, a typed PATH column, and a NESTED PATH group", () => {
  const src =
    "SELECT * FROM JSON_TABLE(p_items, '$[*]' COLUMNS(" +
    "n FOR ORDINALITY, " +
    "doc json PATH '$', " +
    "NESTED PATH '$.tags[*]' COLUMNS(tag varchar(20) PATH '$')" +
    ")) AS j;";
  const result = jsonTableOf(src);
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(result.source, "p_items");
  assert.equal(result.rootPath, "$[*]");
  assert.deepEqual(
    result.columns.map((c) => [c.name, c.ordinality, c.type, c.path]),
    [
      ["n", true, undefined, undefined],
      ["doc", false, "json", "$"],
      ["tag", false, "varchar(20)", "$"],
    ],
  );
});

test("an ON EMPTY / ON ERROR clause after PATH is recognised, not stood down on", () => {
  const src = "SELECT * FROM JSON_TABLE(p_items, '$[*]' COLUMNS(v int PATH '$.v' DEFAULT 0 ON EMPTY ERROR ON ERROR)) AS j;";
  const result = jsonTableOf(src);
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.columns.map((c) => [c.name, c.type, c.path]),
    [["v", "int", "$.v"]],
  );
});

test("a COLUMNS item this does not recognise stands the list down, but keeps what it did read", () => {
  const src = "SELECT * FROM JSON_TABLE(p_items, '$[*]' COLUMNS(v int PATH '$.v', w SOMETHING WEIRD)) AS j;";
  const result = jsonTableOf(src);
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.deepEqual(result.columns.map((c) => c.name), ["v"]);
});

test("a relation that is not JSON_TABLE is not read as one", () => {
  const src = "SELECT * FROM (SELECT 1 AS v) AS j;";
  const tokens = tokenize(src).tokens;
  const relation = relations(mysql, tokens, 0, tokens.length - 1).find((r) => r.derived !== undefined)!;
  assert.equal(jsonTableColumns(tokens, relation), undefined);
});

// ------------------------------------------------------------------ temp table column origins

test("a temporary table's inferred columns keep the span of the expression that fills each one", () => {
  const src =
    "CREATE PROCEDURE p(pDoc json)\nBEGIN\n" +
    "  CREATE TEMPORARY TABLE tmp_orders SELECT order_id, JSON_SET(pDoc, '$.id', order_id) doc FROM orders;\n" +
    "  SELECT 1;\n" +
    "END;";
  const tokens = tokenize(src).tokens;
  const locals = collect(mysql, src, tokens, src.length, parseHeader(src));
  const tmp = locals.byName.get("tmp_orders")!;

  assert.deepEqual(tmp.columns, ["order_id", "doc"]);
  // `order_id` is a plain reference to an existing column, not an expression that fills it.
  assert.equal(tmp.columnOrigins?.[0], undefined);
  const origin = tmp.columnOrigins?.[1];
  assert.ok(origin);
  assert.equal(src.slice(origin.s, origin.e), "JSON_SET(pDoc, '$.id', order_id)");
});

test("a temporary table with an explicit column list has no origins to report", () => {
  const src = "CREATE PROCEDURE p()\nBEGIN\n  CREATE TEMPORARY TABLE tmp (a int, b int);\n  SELECT 1;\nEND;";
  const tokens = tokenize(src).tokens;
  const locals = collect(mysql, src, tokens, src.length, parseHeader(src));
  assert.equal(locals.byName.get("tmp")!.columnOrigins, undefined);
});
