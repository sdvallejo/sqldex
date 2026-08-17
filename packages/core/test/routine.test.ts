/**
 * The same, for routines: what only an example can pin down.
 *
 * The model's own additions — schema, `quoted`, the return type taken apart — plus the one
 * behaviour that is a deliberate choice rather than a reading of the SQL: completing a doc
 * comment that the lexed prefix cut in half.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanDoc, parseHeader } from "../src/syntax/fast/routine.ts";

test("takes the return type apart, like a column's", () => {
  const [fn] = parseHeader("CREATE FUNCTION f(a int) RETURNS decimal(10,2) DETERMINISTIC RETURN 1;");
  assert.equal(fn!.kind, "function");
  assert.deepEqual(fn!.returns, { name: "decimal", args: ["10", "2"], raw: "decimal(10,2)" });
  assert.equal(fn!.signature, "f(a int) RETURNS decimal(10,2)");
});

test("keeps the schema qualifier, and whether names were delimited", () => {
  const [sp] = parseHeader("CREATE PROCEDURE `db`.`sp x`(IN `pA` int, pB char(1)) BEGIN END;");
  assert.equal(sp!.schema, "db");
  assert.equal(sp!.name, "sp x");
  assert.equal(sp!.quoted, true);
  assert.equal(sp!.params[0]!.quoted, true);
  assert.equal(sp!.params[1]!.quoted, false);
  // `IN` is MySQL's default, so only the other modes are rendered.
  assert.equal(sp!.signature, "sp x(pA int, pB char(1))");
});

test("a parameter with no mode defaults to IN", () => {
  const [sp] = parseHeader("CREATE PROCEDURE p(a int, OUT b int, INOUT c int) BEGIN END;");
  assert.deepEqual(
    sp!.params.map((p) => p.mode),
    ["IN", "OUT", "INOUT"],
  );
  assert.equal(sp!.signature, "p(a int, OUT b int, INOUT c int)");
});

test("doubles the prefix until the doc comment closes", () => {
  // Longer than the 1024-character initial prefix, so the first pass cuts it in half.
  const filler = "x".repeat(2000);
  const src = `CREATE PROCEDURE p(a int)\nBEGIN\n/* Doc: ${filler} end. */\nSELECT 1;\nEND;`;
  const [sp] = parseHeader(src);
  assert.ok(sp!.doc!.endsWith("end."), "the doc should be the whole comment, not the part that fitted");
});

test("cleanDoc strips the markers, the guards and the common margin", () => {
  assert.equal(cleanDoc("/**\n * Line one.\n *   Line two.\n */"), "Line one.\n  Line two.");
  assert.equal(cleanDoc("/*\n    a\n      b\n*/"), "a\n  b");
  assert.equal(cleanDoc("/* */"), undefined);
});
