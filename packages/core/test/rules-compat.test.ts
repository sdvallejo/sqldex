/**
 * The rules about what MySQL has announced it will stop accepting.
 *
 * Both are lexical and both run over a whole file, so a case here is a fragment of SQL — a `SELECT`,
 * or a routine body — rather than a table. Each rule runs alone, for the same reason as everywhere
 * else: running the set would make every case depend on the de-duplication order.
 *
 * **Guard pairs.** Neither rule is usable without its guards, and a guard with no control is a
 * hypothesis: the qualified name and the project's own routine sit next to the built-in they collide
 * with, and every form the manual points at as the fix — `SET @a := 1`, `SELECT ... INTO @n` — sits
 * next to the form it replaces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Dialect } from "../src/dialects/dialect.ts";
import type { Routine } from "../src/model/routine.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { Rule, RuleCatalog } from "../src/rules/rule.ts";
import { deprecatedFunction, userVariableInExpression } from "../src/rules/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";

const SCHEMA = [
  "CREATE TABLE orders (",
  "  order_id int NOT NULL,",
  "  payload json NULL,",
  "  extra json NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  PRIMARY KEY (order_id)",
  ");",
].join("\n");

function catalogOf(routineSrc: string): RuleCatalog {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, SCHEMA, tokenize(SCHEMA)).tables) {
    tables.set(table.name.toLowerCase(), table);
  }
  const routines = new Map<string, Routine>();
  for (const routine of parseHeader(routineSrc)) routines.set(routine.name.toLowerCase(), routine);

  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: (name) => (name === undefined ? undefined : routines.get(name.toLowerCase())),
    trigger: () => undefined,
    tempTable: () => undefined,
    tables,
    triggers: new Map(),
    index: (_key, build) => build(tables),
  };
}

/** No routine of the project's own, which is the ordinary case. */
const NO_ROUTINES = "CREATE PROCEDURE sp_plain() BEGIN SELECT 1; END;";

function run(rule: Rule, src: string, options?: { routines?: string; dialect?: Dialect }): string[] {
  return check(
    new Registry().add(rule),
    {
      dialect: options?.dialect ?? mysql,
      catalog: catalogOf(options?.routines ?? NO_ROUTINES),
      schemas: new Set(["shop"]),
      config: defaults,
    },
    src,
  ).map((d) => d.message);
}

/** Wraps lines in a procedure, so a case can be written where these constructs actually live. */
function body(...lines: string[]): string {
  return ["CREATE PROCEDURE sp_case(IN p_order int)", "BEGIN", ...lines, "END;"].join("\n");
}

// ------------------------------------------------------- deprecated functions

test("a call of a deprecated built-in names the version and the replacement", () => {
  assert.deepEqual(run(deprecatedFunction, "SELECT JSON_MERGE(payload, extra) FROM orders;"), [
    "JSON_MERGE is deprecated since MySQL 8.0.3; use JSON_MERGE_PRESERVE or JSON_MERGE_PATCH",
  ]);
});

test("the function that replaces it is not reported", () => {
  assert.deepEqual(run(deprecatedFunction, "SELECT JSON_MERGE_PRESERVE(payload, extra) FROM orders;"), []);
  assert.deepEqual(run(deprecatedFunction, "SELECT JSON_MERGE_PATCH(payload, extra) FROM orders;"), []);
});

test("a call inside a routine body is found too, since the rule reads the file", () => {
  const src = body("  DECLARE v_doc json;", "  SET v_doc = json_merge(@a, @b);");
  assert.deepEqual(run(deprecatedFunction, src), [
    "JSON_MERGE is deprecated since MySQL 8.0.3; use JSON_MERGE_PRESERVE or JSON_MERGE_PATCH",
  ]);
});

test("a qualified name belongs to whoever owns that schema", () => {
  assert.deepEqual(run(deprecatedFunction, "SELECT other_db.json_merge(payload) FROM orders;"), []);
});

test("a routine the project defines itself wins over the engine's own name", () => {
  const mine = "CREATE FUNCTION json_merge(p_a json, p_b json) RETURNS json BEGIN RETURN p_a; END;";
  assert.deepEqual(run(deprecatedFunction, "SELECT json_merge(payload, extra) FROM orders;", { routines: mine }), []);
});

test("the name in a CREATE FUNCTION is a definition, not a call", () => {
  const src = "CREATE FUNCTION json_merge(p_a json) RETURNS json BEGIN RETURN p_a; END;";
  assert.deepEqual(run(deprecatedFunction, src), []);
});

test("a name that is not followed by ( is not a call", () => {
  assert.deepEqual(run(deprecatedFunction, "SELECT json_merge FROM orders;"), []);
  assert.deepEqual(run(deprecatedFunction, "SELECT `json_merge` FROM orders;"), []);
});

test("a dialect whose catalogue deprecates nothing reports nothing", () => {
  const quiet: Dialect = {
    ...mysql,
    functions: new Map([...mysql.functions].map(([name, fn]) => [name, { ...fn, deprecated: undefined }])),
  };
  assert.deepEqual(run(deprecatedFunction, "SELECT JSON_MERGE(payload, extra) FROM orders;", { dialect: quiet }), []);
});

// ------------------------------------------------ user variables in expressions

test("a running total assigned inside a SELECT is reported", () => {
  assert.deepEqual(run(userVariableInExpression, "SELECT @n := @n + 1, order_id FROM orders;"), [
    "assigning to @n outside a SET statement is deprecated; assign it with SET, or SELECT ... INTO @n",
  ]);
});

test("the same assignment written as SET is the form the manual points at", () => {
  assert.deepEqual(run(userVariableInExpression, "SET @n := 0;"), []);
  assert.deepEqual(run(userVariableInExpression, "SET @a := 1, @b := 2;"), []);
});

test("a SET whose right-hand side assigns as well reports the nested one only", () => {
  assert.deepEqual(run(userVariableInExpression, "SET @a = (@b := 1) + 1;"), [
    "assigning to @b outside a SET statement is deprecated; assign it with SET, or SELECT ... INTO @b",
  ]);
});

test("SELECT ... INTO is left alone: that is where the value is supposed to come from", () => {
  assert.deepEqual(run(userVariableInExpression, "SELECT MAX(total) INTO @n FROM orders;"), []);
});

test("a system variable is another subject entirely", () => {
  assert.deepEqual(run(userVariableInExpression, "SET @@session.sql_mode := 'STRICT_ALL_TABLES';"), []);
});

test("a SET inside an IF is still a SET, though its statement begins with the IF", () => {
  const src = body("  IF p_order > 0 THEN", "    SET @n := 1;", "  END IF;");
  assert.deepEqual(run(userVariableInExpression, src), []);
});

test("an assignment inside a routine's expression is reported wherever it sits", () => {
  const src = body("  UPDATE orders SET total = @t := total + 1 WHERE order_id = p_order;");
  assert.deepEqual(run(userVariableInExpression, src), [
    "assigning to @t outside a SET statement is deprecated; assign it with SET, or SELECT ... INTO @t",
  ]);
});

test("each assignment is reported on its own, the way the server warns once per one", () => {
  const src = "SELECT @a := 1, @b := 2 FROM orders;";
  assert.equal(run(userVariableInExpression, src).length, 2);
});
