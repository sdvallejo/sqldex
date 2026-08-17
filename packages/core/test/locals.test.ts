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

import { collect, selectListColumns } from "../src/analysis/locals.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";

function selectOf(src: string, aliasesOnly?: boolean): ReturnType<typeof selectListColumns> {
  const tokens = tokenize(src).tokens;
  const idx = tokens.findIndex((t) => t.t === "id" && t.v.toUpperCase() === "SELECT");
  return selectListColumns(tokens, idx, tokens.length - 1, aliasesOnly);
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
