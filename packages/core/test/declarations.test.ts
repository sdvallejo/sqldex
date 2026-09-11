/**
 * `declarationSection`: reading a routine's own `DECLARE`s in the order MySQL's grammar demands
 * them, and stopping exactly where the section itself does.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { declarationSection } from "../src/syntax/fast/declarations.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

/** `declarationSection` over a body wrapped in `BEGIN … END`, from the `BEGIN` token itself. */
function sectionOf(src: string): ReturnType<typeof declarationSection> {
  const tokens = tokenize(src).tokens;
  const beginIdx = tokens.findIndex((t) => t.t === "id" && t.v.toUpperCase() === "BEGIN");
  return declarationSection(src, tokens, beginIdx);
}

test("a single variable carries its name, its type and no trailing modifier", () => {
  const [d] = sectionOf("BEGIN DECLARE a INT; SELECT a; END;");
  assert.equal(d?.kind, "variable");
  assert.equal(d?.names?.length, 1);
  assert.equal(d?.type?.name, "int");
  assert.equal(d?.hasModifier, false);
});

test("a co-declared list shares one type, and a DEFAULT counts as a modifier", () => {
  const [d] = sectionOf("BEGIN DECLARE a, b INT DEFAULT 7; SELECT a, b; END;");
  assert.equal(d?.kind, "variable");
  assert.equal(d?.names?.length, 2);
  assert.equal(d?.type?.name, "int");
  assert.equal(d?.hasModifier, true);
});

test("CHARACTER SET and COLLATE are modifiers too, not part of the type", () => {
  const [d] = sectionOf("BEGIN DECLARE a VARCHAR(10) CHARACTER SET utf8mb4; SELECT a; END;");
  assert.equal(d?.type?.name, "varchar");
  assert.equal(d?.hasModifier, true);
});

test("a cursor and a condition carry no names or type of their own", () => {
  const section = sectionOf(
    "BEGIN DECLARE not_found CONDITION FOR SQLSTATE '02000'; DECLARE cur CURSOR FOR SELECT 1; SELECT 1; END;",
  );
  assert.deepEqual(
    section.map((d) => d.kind),
    ["condition", "cursor"],
  );
  assert.equal(section[0]?.names, undefined);
  assert.equal(section[0]?.type, undefined);
});

test("a handler's BEGIN … END action is skipped by block depth, not by its own first semicolon", () => {
  const src = [
    "BEGIN",
    "  DECLARE done INT DEFAULT 0;",
    "  DECLARE cur CURSOR FOR SELECT 1;",
    "  DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN SET done = 1; END;",
    "  SELECT done;",
    "END;",
  ].join("\n");
  const tokens = tokenize(src).tokens;
  const section = sectionOf(src);
  assert.deepEqual(
    section.map((d) => d.kind),
    ["variable", "cursor", "handler"],
  );
  // The handler's own `;` is the one after its `END`, not the one inside it.
  const handler = section[2]!;
  assert.equal(tokens[handler.to]!.v, ";");
  assert.equal(tokens[handler.to - 1]!.v.toUpperCase(), "END");
});

test("the section stops at the block's first statement, and a DECLARE after it is not part of it", () => {
  const section = sectionOf("BEGIN DECLARE a INT; SELECT a; DECLARE b INT; END;");
  assert.equal(section.length, 1);
  assert.equal(section[0]?.names?.length, 1);
});

test("a block with no DECLARE at all has an empty section", () => {
  assert.deepEqual(sectionOf("BEGIN SELECT 1; END;"), []);
});
