/**
 * The rules that read the whole file: variables, cursors, and ambiguity.
 *
 * These are the lexical rules, so a case is a routine body rather than a table — the subject is what
 * the code *does* with a name, not what the schema says about it. The catalog is still built from
 * DDL, because half of these need to know a column is nullable or that two relations share a name.
 *
 * Each rule runs alone, for the same reason as in the schema slice: running the set would make every
 * case depend on the de-duplication order.
 *
 * **Guard pairs.** Every one of these five is only usable because of a guard, and a guard with no
 * control is a hypothesis. So each gets the case that must go quiet next to the neighbour that must
 * still sound: the `COALESCE` that makes a NULL read deliberate, the `OUT` argument that cannot be
 * deleted, the `USING` that merges an ambiguous column away.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { columnTypeCensus } from "../src/catalog/catalog.ts";
import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Routine } from "../src/model/routine.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { Rule, RuleCatalog } from "../src/rules/rule.ts";
import {
  ambiguousColumn,
  cursorNeverOpened,
  nullableIntoArithmetic,
  unusedVariable,
  variableNeverAssigned,
} from "../src/rules/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";

/** The schema every case resolves against, unless it brings its own. */
const SCHEMA = [
  "CREATE TABLE orders (",
  "  order_id int NOT NULL,",
  "  customer_id int NOT NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  discount decimal(10,2) NULL,",
  "  PRIMARY KEY (order_id)",
  ");",
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  label varchar(40) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
].join("\n");

/**
 * A procedure whose last parameter is written by the callee, which is how a body gets a value back.
 * Declared as DDL text so the parameter modes come from the real header parser.
 */
const ROUTINES = [
  "CREATE PROCEDURE sp_plain() BEGIN SELECT 1; END;",
  "CREATE PROCEDURE sp_returns(IN p_in int, OUT p_out int) BEGIN SET p_out = p_in; END;",
].join("\n");

function catalogOf(schema: string, routineSrc = ROUTINES): RuleCatalog {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, schema, tokenize(schema)).tables) {
    if (!table.temporary) tables.set(table.name.toLowerCase(), table);
  }
  const routines = new Map<string, Routine>();
  for (const routine of parseHeader(routineSrc)) routines.set(routine.name.toLowerCase(), routine);

  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: (name) => (name === undefined ? undefined : routines.get(name.toLowerCase())),
    trigger: () => undefined,
    tempTable: () => undefined,
    columnTypes: () => columnTypeCensus(mysql, tables),
  };
}

function run(rule: Rule, src: string, schema = SCHEMA): string[] {
  return check(
    new Registry().add(rule),
    { dialect: mysql, catalog: catalogOf(schema), schemas: new Set(["shop"]), config: defaults },
    src,
  ).map((d) => d.message);
}

/** Wraps a body in a procedure, which is what makes its `DECLARE`s locals. */
function body(...lines: string[]): string {
  return ["CREATE PROCEDURE sp_case(IN p_order int)", "BEGIN", ...lines, "END;"].join("\n");
}

// -------------------------------------------------------------------- cursors

test("a cursor declared and never opened is reported", () => {
  const src = body("  DECLARE c_rows CURSOR FOR SELECT order_id FROM orders;", "  SELECT 1;");
  assert.deepEqual(run(cursorNeverOpened, src), ["cursor c_rows is declared but never opened"]);
});

test("a cursor that is opened is not", () => {
  const src = body(
    "  DECLARE c_rows CURSOR FOR SELECT order_id FROM orders;",
    "  OPEN c_rows;",
    "  CLOSE c_rows;",
  );
  assert.deepEqual(run(cursorNeverOpened, src), []);
});

test("the OPEN is matched case-insensitively, so a typo in DECLARE cannot hide the cursor", () => {
  // `DEClARE` with a stray capital is exactly the kind of thing that sits in a body for years.
  const src = body("  DEClARE c_rows CURSOR FOR SELECT order_id FROM orders;", "  open C_ROWS;");
  assert.deepEqual(run(cursorNeverOpened, src), []);
});

// ------------------------------------------------------------ unused variables

test("a variable nobody mentions again is a leftover", () => {
  const src = body("  DECLARE v_left int DEFAULT 0;", "  SELECT 1;");
  assert.deepEqual(run(unusedVariable, src), ["unused variable: v_left"]);
});

test("a variable that is assigned and never read reads differently", () => {
  const src = body(
    "  DECLARE v_total decimal(10,2);",
    "  SELECT total INTO v_total FROM orders WHERE order_id = p_order;",
  );
  assert.deepEqual(run(unusedVariable, src), ["v_total is assigned but never read"]);
});

test("a read is a read, including on the right of its own assignment", () => {
  const src = body("  DECLARE v_n int DEFAULT 0;", "  SET v_n = v_n + 1;");
  assert.deepEqual(run(unusedVariable, src), [], "SET v = v + 1 uses the variable");
});

test("a variable that only absorbs an OUT argument is left alone", () => {
  // MySQL demands a variable there whether the value is wanted or not, so greying out the name
  // would point at something its author cannot remove.
  const src = body("  DECLARE v_sink int;", "  CALL sp_returns(1, v_sink);");
  assert.deepEqual(run(unusedVariable, src), []);
});

test("but a variable passed to an IN parameter is only being read", () => {
  const src = body("  DECLARE v_arg int DEFAULT 1;", "  CALL sp_returns(v_arg, @out);");
  assert.deepEqual(run(unusedVariable, src), [], "that is a read, so nothing is surplus");
});

test("a parameter is never called unused: removing one breaks every caller", () => {
  const src = body("  SELECT 1;");
  assert.deepEqual(run(unusedVariable, src), []);
});

test("the hint is tagged unnecessary, which is what greys the name out", () => {
  const src = body("  DECLARE v_left int DEFAULT 0;", "  SELECT 1;");
  const found = check(
    new Registry().add(unusedVariable),
    { dialect: mysql, catalog: catalogOf(SCHEMA), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(found[0]?.tags, ["unnecessary"]);
  assert.equal(found[0]?.severity, "hint");
});

// -------------------------------------------------------- never-assigned reads

test("a variable nothing assigns is reported on its first read, not on the DECLARE", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = v_group;",
  );
  const found = run(variableNeverAssigned, src);
  assert.deepEqual(found, ["v_group is never assigned, so this reads NULL"]);
});

test("a DEFAULT makes it initialised, whatever the value", () => {
  const src = body(
    "  DECLARE v_group int DEFAULT 0;",
    "  SELECT order_id FROM orders WHERE customer_id = v_group;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), []);
});

test("an assignment anywhere in the body clears it, even below the read", () => {
  // The obvious extension — flagging a read above the first write — is deliberately not attempted:
  // in a loop that read runs after the write on the second pass.
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = v_group;",
    "  SET v_group = 1;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), []);
});

test("a read wrapped in COALESCE is deliberate, and stays quiet", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group, 0);",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [], "the NULL never escapes");
});

test("the wrapper counts from any depth out", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE((v_group + 1) * 2, 0);",
  );
  assert.deepEqual(run(variableNeverAssigned, src), []);
});

test("but an unwrapped read next to a wrapped one is still reported", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT COALESCE(v_group, 0) FROM orders WHERE customer_id = v_group;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [
    "v_group is never assigned, so this reads NULL",
  ]);
});

test("an OUT argument counts as a write, because the callee fills it in", () => {
  const src = body(
    "  DECLARE v_got int;",
    "  CALL sp_returns(1, v_got);",
    "  SELECT order_id FROM orders WHERE customer_id = v_got;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [], "that is the idiom, not a defect");
});

test("passing it to an IN parameter is not a write", () => {
  const src = body("  DECLARE v_got int;", "  CALL sp_returns(v_got, @sink);");
  assert.deepEqual(run(variableNeverAssigned, src), [
    "v_got is never assigned, so this reads NULL",
  ]);
});

// ------------------------------------------------- nullable through a variable

test("a nullable column reaching arithmetic through a variable is reported", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT v_disc * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_disc comes from orders.discount, which is nullable; without COALESCE the whole expression is NULL",
  ]);
});

test("a NOT NULL column taints nothing", () => {
  const src = body(
    "  DECLARE v_total decimal(10,2);",
    "  SELECT total INTO v_total FROM orders WHERE order_id = p_order;",
    "  SELECT v_total * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("the SELECT list is matched to the INTO list by position, the way MySQL assigns them", () => {
  const src = body(
    "  DECLARE v_a decimal(10,2);",
    "  DECLARE v_b decimal(10,2);",
    "  SELECT total, discount INTO v_a, v_b FROM orders WHERE order_id = p_order;",
    "  SELECT v_a * 2, v_b * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_b comes from orders.discount, which is nullable; without COALESCE the whole expression is NULL",
  ]);
});

test("an expression in the slot taints nothing: the rule never guesses", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT COALESCE(discount, 0) INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT v_disc * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("a qualified column in the slot is followed too", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT o.discount INTO v_disc FROM orders o WHERE o.order_id = p_order;",
    "  SELECT v_disc + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_disc comes from orders.discount, which is nullable; without COALESCE the whole expression is NULL",
  ]);
});

test("a tainted variable used without arithmetic is not reported", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT order_id FROM orders WHERE discount = v_disc;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [], "a comparison is a different defect");
});

test("wrapping the use in COALESCE is the fix, and it is recognised as one", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT COALESCE(v_disc, 0) * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

// ------------------------------------------------------------------ ambiguity

test("a bare column two of the query's relations have is an error", () => {
  const src = "SELECT order_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE customer_id = 1;";
  assert.deepEqual(run(ambiguousColumn, src), [
    "customer_id is ambiguous: o and c both have it",
  ]);
});

test("a column only one of them has is fine", () => {
  const src = "SELECT total FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE total > 0;";
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("three relations read as `all` rather than `both`", () => {
  const schema = [
    SCHEMA,
    "CREATE TABLE refunds (customer_id int NOT NULL, PRIMARY KEY (customer_id));",
  ].join("\n");
  const src =
    "SELECT 1 FROM orders o JOIN customers c ON o.customer_id = c.customer_id " +
    "JOIN refunds r ON r.customer_id = c.customer_id WHERE customer_id = 1;";
  assert.deepEqual(run(ambiguousColumn, src, schema), [
    "customer_id is ambiguous: o, c and r all have it",
  ]);
});

test("USING merges the column, which is exactly what stops it being ambiguous", () => {
  const src = "SELECT 1 FROM orders o JOIN customers c USING (customer_id) WHERE customer_id = 1;";
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("a NATURAL JOIN merges every shared name", () => {
  const src = "SELECT 1 FROM orders o NATURAL JOIN customers c WHERE customer_id = 1;";
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("the query bound is the scope, not the semicolon", () => {
  // Read at statement level these two relations share `customer_id` and the rule would fire. They
  // are two queries, and neither is ambiguous on its own.
  const src = body(
    "  IF EXISTS(SELECT 1 FROM orders WHERE customer_id = p_order) THEN",
    "    UPDATE customers SET label = 'x' WHERE customer_id = p_order;",
    "  END IF;",
  );
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("ORDER BY sees the output names, where WHERE does not", () => {
  const src =
    "SELECT o.customer_id FROM orders o JOIN customers c ON o.customer_id = c.customer_id ORDER BY customer_id;";
  assert.deepEqual(run(ambiguousColumn, src), [], "those three clauses resolve against the output");
});

test("a name the SELECT list defines is not a column reference", () => {
  // The same word twice, and the first one **is** a column: only position tells them apart.
  const src =
    "SELECT DATE_FORMAT(o.total, '%d') total FROM orders o JOIN customers c ON o.customer_id = c.customer_id;";
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("a local of that name is not a column reference either", () => {
  const src = body(
    "  DECLARE customer_id int DEFAULT 1;",
    "  SELECT 1 FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE customer_id = 1;",
  );
  assert.deepEqual(run(ambiguousColumn, src), []);
});

test("a name resolves in the innermost scope that has it, and stops there", () => {
  // The subquery has one relation, so `customer_id` is unambiguous there — MySQL never looks
  // further out once a scope has the name.
  const src =
    "SELECT 1 FROM orders o JOIN customers c ON o.customer_id = c.customer_id " +
    "WHERE o.order_id IN (SELECT order_id FROM orders WHERE customer_id = 1);";
  assert.deepEqual(run(ambiguousColumn, src), []);
});
