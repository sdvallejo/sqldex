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

import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Routine } from "../src/model/routine.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { Rule, RuleCatalog } from "../src/rules/rule.ts";
import {
  ambiguousColumn,
  cursorNeverOpened,
  deadCoalesceDefault,
  declareAfterStatement,
  exclusiveBranchAnd,
  nullableIntoArithmetic,
  nullableVariableInConcat,
  nullableVariableInPredicate,
  outParamNeverAssigned,
  shadowedParameter,
  unknownLabel,
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
    tables,
    triggers: new Map(),
    index: (_key, build) => build(tables),
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

// ------------------------------------------------------------ shadowed parameters

test("a DECLARE reusing an IN parameter's name, read again, is reported", () => {
  const src = [
    "CREATE PROCEDURE sp_case(IN p_order int)",
    "BEGIN",
    "  DECLARE p_order int DEFAULT 0;",
    "  SELECT p_order;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(shadowedParameter, src), [
    "p_order shadows the parameter p_order: this DECLARE creates a new variable, so the parameter's value is unreachable under this name for the rest of the block",
  ]);
});

test("a DECLARE reusing an OUT parameter's name, then SET, is reported: the SET never reaches the caller", () => {
  const src = [
    "CREATE PROCEDURE sp_case(IN p_x int, OUT p_result int)",
    "BEGIN",
    "  DECLARE p_result int DEFAULT 0;",
    "  SET p_result = p_x * 2;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(shadowedParameter, src), [
    "p_result shadows the parameter p_result: this DECLARE creates a new variable, so the parameter's value is unreachable under this name for the rest of the block",
  ]);
});

test("a shadowing DECLARE nobody mentions again is unused-variable's to report, not this rule's", () => {
  const src = body("  DECLARE p_order int DEFAULT 0;", "  SELECT 1;");
  assert.deepEqual(run(shadowedParameter, src), []);
  assert.deepEqual(run(unusedVariable, src), ["unused variable: p_order"]);
});

test("a DECLARE with its own name, not a parameter's, is not this rule's business", () => {
  const src = body("  DECLARE v_total int DEFAULT 0;", "  SELECT v_total;");
  assert.deepEqual(run(shadowedParameter, src), []);
});

test("the match is case-insensitive, the way MySQL folds identifiers", () => {
  const src = [
    "CREATE PROCEDURE sp_case(IN p_order int)",
    "BEGIN",
    "  DECLARE P_ORDER int DEFAULT 0;",
    "  SELECT P_ORDER;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(shadowedParameter, src), [
    "P_ORDER shadows the parameter p_order: this DECLARE creates a new variable, so the parameter's value is unreachable under this name for the rest of the block",
  ]);
});

test("a variable read in the next routine is not reported against this one's parameter", () => {
  const src = [
    "CREATE PROCEDURE sp_first(IN p_order int)",
    "BEGIN",
    "  SELECT p_order;",
    "END;",
    "CREATE PROCEDURE sp_second()",
    "BEGIN",
    "  DECLARE p_order int DEFAULT 0;",
    "  SELECT p_order;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(shadowedParameter, src), [], "sp_second has no parameter named p_order");
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

test("GET DIAGNOSTICS fills its targets, which is what a HANDLER block is written around", () => {
  const src = body(
    "  DECLARE v_state CHAR(5);",
    "  DECLARE v_errno int;",
    "  DECLARE v_msg varchar(512);",
    "  DECLARE EXIT HANDLER FOR SQLEXCEPTION",
    "  BEGIN",
    "    GET DIAGNOSTICS CONDITION 1 v_state = RETURNED_SQLSTATE, v_errno = MYSQL_ERRNO, v_msg = MESSAGE_TEXT;",
    "    IF v_state <> '45000' THEN",
    "      SELECT v_errno, v_msg;",
    "    END IF;",
    "    RESIGNAL;",
    "  END;",
    "  SELECT 1;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [], "the handler assigns all three");
});

test("the statement-information form of GET DIAGNOSTICS writes its target too", () => {
  const src = body(
    "  DECLARE v_n int;",
    "  GET DIAGNOSTICS v_n = NUMBER;",
    "  SELECT order_id FROM orders WHERE customer_id = v_n;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), []);
});

test("GET CURRENT DIAGNOSTICS and GET STACKED DIAGNOSTICS are the same statement", () => {
  const current = body("  DECLARE v_n int;", "  GET CURRENT DIAGNOSTICS v_n = NUMBER;", "  SELECT v_n;");
  const stacked = body("  DECLARE v_n int;", "  GET STACKED DIAGNOSTICS v_n = NUMBER;", "  SELECT v_n;");
  assert.deepEqual(run(variableNeverAssigned, current), []);
  assert.deepEqual(run(variableNeverAssigned, stacked), []);
});

test("the condition number of a GET DIAGNOSTICS is read, not written", () => {
  // The guard pair with the three above: a variable naming *which* condition to read is a read, and
  // a rule that counted it as a write would stop reporting a condition number nothing ever set.
  const src = body(
    "  DECLARE v_which int;",
    "  DECLARE v_state CHAR(5);",
    "  GET DIAGNOSTICS CONDITION v_which v_state = RETURNED_SQLSTATE;",
    "  SELECT v_state;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [
    "v_which is never assigned, so this reads NULL",
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

test("a self-INTO is not a write, so a later read still reads NULL", () => {
  // `routine/select-into-self` reports the copy-pasted line itself; this rule reports what it
  // leaves behind, on the read that actually uses the value.
  const src = body(
    "  DECLARE v_customer_id int;",
    "  SELECT order_id, v_customer_id INTO p_order, v_customer_id FROM orders WHERE customer_id = p_order;",
    "  SELECT total FROM orders WHERE customer_id != v_customer_id;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [
    "v_customer_id is never assigned, so this reads NULL",
  ]);
});

test("SET v = v is not a write either", () => {
  const src = body(
    "  DECLARE v_customer_id int;",
    "  SET v_customer_id = v_customer_id;",
    "  SELECT total FROM orders WHERE customer_id != v_customer_id;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [
    "v_customer_id is never assigned, so this reads NULL",
  ]);
});

test("a genuine assignment elsewhere still clears it, self-INTO or not", () => {
  const src = body(
    "  DECLARE v_customer_id int;",
    "  SELECT order_id, v_customer_id INTO p_order, v_customer_id FROM orders WHERE customer_id = p_order;",
    "  SET v_customer_id = p_order;",
    "  SELECT total FROM orders WHERE customer_id != v_customer_id;",
  );
  assert.deepEqual(run(variableNeverAssigned, src), []);
});

// ------------------------------------------------- dead COALESCE/IFNULL defaults

test("a never-assigned variable as a bare COALESCE argument is a dead default", () => {
  // The guard pair with the case above: variableNeverAssigned stays quiet here on purpose, and this
  // is the rule that speaks instead, because the wrap does not make the read safe — it makes the
  // whole call collapse to the other argument, always.
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group, 0);",
  );
  assert.deepEqual(run(variableNeverAssigned, src), [], "the COALESCE-wrap exemption, unchanged");
  assert.deepEqual(run(deadCoalesceDefault, src), [
    "v_group is never assigned, so it is always NULL; COALESCE(…) always evaluates to its other argument here",
  ]);
});

test("the variable can sit in either position of a two-argument IFNULL", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = IFNULL(0, v_group);",
  );
  assert.deepEqual(run(deadCoalesceDefault, src), [
    "v_group is never assigned, so it is always NULL; IFNULL(…) always evaluates to its other argument here",
  ]);
});

test("a three-argument COALESCE is out of scope: the result is no longer a single fixed value", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group, discount, 0);",
  );
  assert.deepEqual(run(deadCoalesceDefault, src), []);
});

test("a variable buried in an expression is left to variable-never-assigned, not guessed at here", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group + 1, 0);",
  );
  assert.deepEqual(run(deadCoalesceDefault, src), []);
});

test("an assignment anywhere in the body clears it, same as its sibling rule", () => {
  const src = body(
    "  DECLARE v_group int;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group, 0);",
    "  SET v_group = 1;",
  );
  assert.deepEqual(run(deadCoalesceDefault, src), []);
});

test("a DEFAULT makes it initialised, whatever the value", () => {
  const src = body(
    "  DECLARE v_group int DEFAULT 0;",
    "  SELECT order_id FROM orders WHERE customer_id = COALESCE(v_group, 1);",
  );
  assert.deepEqual(run(deadCoalesceDefault, src), []);
});

// ------------------------------------------------- exclusive-branch AND

test("two variables set in different arms of one IF, ANDed together, is reported", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v2 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("a write to either variable between the IF and the check is the fix, and stays quiet", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  SET v1 = 0;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("an IF nested inside one arm does not hide the arms of the IF around it", () => {
  // The `IF` of the inner `END IF` is the closing's own word, not a new block: read as one, it
  // would sit on top of the outer frame and swallow its `ELSE`.
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    IF p_order > 0 THEN SELECT 1; END IF;",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.equal(run(exclusiveBranchAnd, src).length, 1);
});

test("an IS NOT NULL test on either variable, anywhere in the statement, has handled it", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 AND v1 IS NOT NULL THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("<=> is the fix, not the defect", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 <=> 0 AND v2 <=> 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("an OUT argument of a CALL counts as a branch write", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    CALL sp_returns(1, v1);",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v2 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("and an OUT argument counts as the intervening write too", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  CALL sp_returns(1, v1);",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("a write before the IF means the variable never started NULL there, and stays quiet", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  SET v1 = -1;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("an unrelated write after the check does not retroactively excuse it", () => {
  // The cutoff for "did this start NULL" is the IF's own token index, not "anywhere in the
  // routine" — a write further down, after the defect already fired, must not silence it.
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
    "  SET v1 = 99;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v2 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("three arms: non-adjacent arms are still exclusive", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  DECLARE v3 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSEIF p_order = 2 THEN",
    "    SET v2 = 1;",
    "  ELSE",
    "    SET v3 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v3 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v3 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("three arms: a variable written in two of them is not exclusive against a partner in one of the same two", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSEIF p_order = 2 THEN",
    "    SET v1 = 2;",
    "    SET v2 = 1;",
    "  ELSE",
    "    SET v1 = 3;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [], "arm 2 (0-based 1) writes both, so they are not disjoint");
});

test("a variable this IF never touches at all is not a partner, however it got its value", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SELECT 1;",
    "  END IF;",
    "  SET v2 = 5;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("NOT around the whole AND makes the opposite claim, and is not this rule's business", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF NOT (v1 = 0 AND v2 = 0) THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("a single-branch IF has no second arm for a partner to be exclusive against", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  END IF;",
    "  SET v2 = 0;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
});

test("a write nested inside a BEGIN block inside an arm still belongs to that arm", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    BEGIN",
    "      SET v1 = 1;",
    "    END;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v2 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("the IF() function inside a condition is not mistaken for control flow", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF IF(p_order > 0, 1, 0) = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = 0 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), [
    "v1 and v2 are set in different branches of the same IF — at most one is ever non-NULL, so this AND can never be true",
  ]);
});

test("a multi-token right-hand side is a known limitation, not modelled", () => {
  const src = body(
    "  DECLARE v1 int;",
    "  DECLARE v2 int;",
    "  IF p_order = 1 THEN",
    "    SET v1 = 1;",
    "  ELSE",
    "    SET v2 = 1;",
    "  END IF;",
    "  IF v1 = p_order + 1 AND v2 = 0 THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.deepEqual(run(exclusiveBranchAnd, src), []);
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

// --------------------------------- the second source: an aggregate or a subquery NULL over no rows

test("SET from an aggregate that is NULL over no rows taints the variable", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_used was set from a SUM that is NULL over no rows; without COALESCE the whole expression is NULL",
  ]);
});

test("the parentheses of an IF statement's condition are not the IF() function", () => {
  // Two variables, not one: the empty-result source is now reported once per variable at its first
  // read (see the "one finding per variable" tests below), so one variable would only show this once
  // however many `IF` conditions it sat in — which would not tell the two parenthesised shapes apart.
  const loud = body(
    "  DECLARE v_a decimal(10,2);",
    "  DECLARE v_b decimal(10,2);",
    "  SET v_a = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SET v_b = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  IF (v_a + 1 > 100) THEN SELECT 1; END IF;",
    "  IF v_a > 0 THEN SELECT 2; ELSE IF (v_b * 2 > 5) THEN SELECT 3; END IF; END IF;",
  );
  assert.equal(run(nullableIntoArithmetic, loud).length, 2);

  // The function does absorb it: IF(c, a, b) picks a branch, it does not propagate.
  const quiet = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT IF(v_used IS NULL, 0, v_used + 1);",
  );
  assert.deepEqual(run(nullableIntoArithmetic, quiet), []);
});

test("an unprotected aggregate slot of a SELECT ... INTO taints its target the same way", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SELECT SUM(total) INTO v_used FROM orders WHERE customer_id = p_order;",
    "  SELECT v_used * 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_used was set from a SUM that is NULL over no rows; without COALESCE the whole expression is NULL",
  ]);
});

test("a column-origin message stays byte-identical next to the new empty-result source", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  DECLARE v_used decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_disc * 2, v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_disc comes from orders.discount, which is nullable; without COALESCE the whole expression is NULL",
    "v_used was set from a SUM that is NULL over no rows; without COALESCE the whole expression is NULL",
  ]);
});

test("an aggregate already wrapped in COALESCE inside the subquery is not a source", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("COUNT does not turn an empty set into a NULL, so it taints nothing", () => {
  const src = body(
    "  DECLARE v_used int;",
    "  SET v_used = (SELECT COUNT(*) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("a lookup of one row by its full primary key is not a source", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT total FROM orders WHERE order_id = p_order);",
    "  SELECT v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("a SELECT with no FROM computes its one row out of nothing, so it is not a source", () => {
  const src = body(
    "  DECLARE v_used int;",
    "  SET v_used = (SELECT 1);",
    "  SELECT v_used + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("a statement that asks about the NULL itself has handled the empty-result source too", () => {
  // Only `nullableVariableInPredicate` and `nullableVariableInConcat` follow `taintedReads`, and its
  // `IS NULL` guard, so that is where this belongs: `nullableIntoArithmetic` reads `nullableSources`
  // directly and has no such guard, the same as it does not for a column-origin taint.
  const src = body(
    "  DECLARE v_total decimal(10,2);",
    "  SET v_total = (SELECT total FROM orders WHERE customer_id = p_order);",
    "  IF v_total IS NOT NULL AND v_total != 0 THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), []);
});

test("a plain SELECT col INTO v finding nothing leaves v unchanged, not NULL, so it is not a source", () => {
  const src = body(
    "  DECLARE v_total decimal(10,2);",
    "  SELECT total INTO v_total FROM orders WHERE customer_id = p_order;",
    "  SELECT v_total + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

test("COALESCE around the read is the fix for the empty-result source too", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT COALESCE(v_used, 0) + 1;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

// ---------------------------------------- one finding per variable, for the empty-result source

test("an empty-result taint is reported once, at its first read, not at every read", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_used + 1;",
    "  SELECT v_used + 2;",
  );
  assert.deepEqual(run(nullableIntoArithmetic, src), [
    "v_used was set from a SUM that is NULL over no rows; without COALESCE the whole expression is NULL",
  ]);
});

test("the same variable reaching arithmetic and CONCAT is reported once in each rule", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT SUM(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT v_used + 1;",
    "  SELECT CONCAT('x', v_used);",
  );
  // Each rule runs alone and dedups on its own, so the same variable can still be one finding here
  // and one finding there — it is only within a single rule's own findings that the second read of
  // the same no-rows source drops out.
  assert.equal(run(nullableIntoArithmetic, src).length, 1);
  assert.equal(run(nullableVariableInConcat, src).length, 1);
});

test("a column-origin taint is still reported at every read, not just the first", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT v_disc + 1;",
    "  SELECT v_disc + 2;",
  );
  assert.equal(run(nullableIntoArithmetic, src).length, 2);
});

// ------------------------------------------------- a to-one join is still a lookup, not a search

/** `orders` gains a declared foreign key onto `customers`' own primary key. */
const FK_SCHEMA = [
  "CREATE TABLE orders (",
  "  order_id int NOT NULL,",
  "  customer_id int NOT NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  discount decimal(10,2) NULL,",
  "  PRIMARY KEY (order_id),",
  "  FOREIGN KEY (customer_id) REFERENCES customers (customer_id)",
  ");",
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  label varchar(40) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
].join("\n");

test("a to-one join through a declared foreign key is still a lookup, so it taints nothing", () => {
  const src = body(
    "  DECLARE v_name varchar(40);",
    "  SET v_name = (SELECT c.label FROM orders o JOIN customers c USING (customer_id) " +
      "WHERE o.order_id = p_order);",
    "  SELECT CONCAT('x', v_name);",
  );
  assert.deepEqual(run(nullableVariableInConcat, src, FK_SCHEMA), []);
});

test("the same join without a declared foreign key is a search, and taints the variable", () => {
  const src = body(
    "  DECLARE v_name varchar(40);",
    "  SET v_name = (SELECT c.label FROM orders o JOIN customers c USING (customer_id) " +
      "WHERE o.order_id = p_order);",
    "  SELECT CONCAT('x', v_name);",
  );
  assert.deepEqual(run(nullableVariableInConcat, src, SCHEMA), [
    "v_name was set from a subquery that is NULL over no rows; one NULL argument makes the whole CONCAT NULL",
  ]);
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

test("the row alias of an INSERT does not make the target's own columns ambiguous", () => {
  // `AS new_order` names the row being inserted, whose columns are `orders`' own. Counting it as a
  // second relation would report every assignment in the clause as ambiguous, which MySQL does not.
  const src = [
    "INSERT INTO orders (order_id, customer_id, total)",
    "  VALUES (1, 2, 3.00) AS new_order",
    "  ON DUPLICATE KEY UPDATE total = new_order.total;",
  ].join("\n");
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

// -------------------------------------- nullable through a variable, into a predicate

test("a nullable variable in a negated comparison is reported", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc != 0 THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), [
    'v_disc comes from orders.discount, which is nullable, and a NULL is not "!=" anything: ' +
      "MySQL answers unknown, which reads as false",
  ]);
});

test("the same comparison written with = is not reported, and that is the whole argument", () => {
  // Unknown-reads-as-false and "it is not zero" are the same answer for `=`. They are opposite
  // answers for `!=`, which is why only one of the two is a finding.
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc = 0 THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), []);
});

test("NOT IN is the same defect spelled with a word", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc NOT IN (1, 2) THEN SELECT 1; END IF;",
  );
  assert.equal(run(nullableVariableInPredicate, src).length, 1);
});

test("a statement that asks about the NULL itself has handled it", () => {
  const guarded = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc IS NOT NULL AND v_disc != 0 THEN SELECT 1; END IF;",
  );
  const bare = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc != 0 THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, guarded), []);
  assert.equal(run(nullableVariableInPredicate, bare).length, 1);
});

test("the NULL-safe operator is the fix, not the defect", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF NOT (v_disc <=> 0) THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), []);
});

test("an IF arm reached only after asking about the NULL has handled it", () => {
  // Inside the outer arm the variable is known not to be NULL; the inner comparison never repeats
  // the test, and does not need to.
  const guarded = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc IS NOT NULL THEN",
    "    IF v_disc != 0 THEN SELECT 1; END IF;",
    "  END IF;",
  );
  const bare = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF p_order > 0 THEN",
    "    IF v_disc != 0 THEN SELECT 1; END IF;",
    "  END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, guarded), []);
  assert.equal(run(nullableVariableInPredicate, bare).length, 1);
});

test("a CONCAT is not a predicate, and has a rule of its own", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT CONCAT('discount: ', v_disc);",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), []);
});

test("a SET from a search rather than a key lookup reaches a negated comparison", () => {
  // customer_id is not a key of orders, so this is a search, not a lookup of one row.
  const src = body(
    "  DECLARE v_total decimal(10,2);",
    "  SET v_total = (SELECT total FROM orders WHERE customer_id = p_order);",
    "  IF v_total != 0 THEN SELECT 1; END IF;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), [
    'v_total was set from a subquery that is NULL over no rows, and a NULL is not "!=" anything: ' +
      "MySQL answers unknown, which reads as false",
  ]);
});

// ------------------------------------------------ nullable through a variable, into a CONCAT

test("one NULL argument takes the whole CONCAT with it", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT CONCAT('discount: ', v_disc);",
  );
  assert.deepEqual(run(nullableVariableInConcat, src), [
    "v_disc comes from orders.discount, which is nullable; one NULL argument makes the whole CONCAT NULL",
  ]);
});

test("a SET from an aggregate that is NULL over no rows reaches a CONCAT", () => {
  const src = body(
    "  DECLARE v_used decimal(10,2);",
    "  SET v_used = (SELECT MAX(total) FROM orders WHERE customer_id = p_order);",
    "  SELECT CONCAT('total: ', v_used);",
  );
  assert.deepEqual(run(nullableVariableInConcat, src), [
    "v_used was set from a MAX that is NULL over no rows; one NULL argument makes the whole CONCAT NULL",
  ]);
});

test("the innermost wrapper is the one that counts, and CONCAT_WS skips its NULLs", () => {
  const fixed = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT CONCAT('discount: ', COALESCE(v_disc, 0));",
  );
  const skipped = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT CONCAT_WS(' ', 'discount:', v_disc);",
  );
  assert.deepEqual(run(nullableVariableInConcat, fixed), []);
  assert.deepEqual(run(nullableVariableInConcat, skipped), []);
});

test("an arm after an ELSEIF that asked about the NULL knows the answer", () => {
  // Reaching the second arm means `v_disc IS NULL` was asked and came back no.
  const guarded = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF p_order < 0 THEN",
    "    SELECT 1;",
    "  ELSEIF v_disc IS NULL THEN",
    "    SELECT 2;",
    "  ELSEIF p_order > 0 THEN",
    "    SELECT CONCAT('discount: ', v_disc);",
    "  END IF;",
  );
  const bare = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF p_order < 0 THEN",
    "    SELECT 1;",
    "  ELSEIF p_order > 0 THEN",
    "    SELECT CONCAT('discount: ', v_disc);",
    "  END IF;",
  );
  assert.deepEqual(run(nullableVariableInConcat, guarded), []);
  assert.equal(run(nullableVariableInConcat, bare).length, 1);
});

test("the ELSE after an IS NULL arm knows the answer too", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF v_disc IS NULL THEN",
    "    SELECT 1;",
    "  ELSE",
    "    SELECT CONCAT('discount: ', v_disc);",
    "  END IF;",
  );
  assert.deepEqual(run(nullableVariableInConcat, src), []);
});

test("an IS NULL test after the arm, not before it, guards nothing", () => {
  // Only arms that ran their conditions before this one know anything; a later ELSEIF was never asked.
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF p_order > 0 THEN",
    "    SELECT CONCAT('discount: ', v_disc);",
    "  ELSEIF v_disc IS NULL THEN",
    "    SELECT 1;",
    "  END IF;",
  );
  assert.equal(run(nullableVariableInConcat, src).length, 1);
});

test("a read inside CONCAT that is also arithmetic belongs to the arithmetic rule", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT CONCAT('discount: ', v_disc + 1);",
  );
  const found = check(
    new Registry().add(nullableIntoArithmetic, nullableVariableInConcat),
    { dialect: mysql, catalog: catalogOf(SCHEMA), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => d.code),
    ["routine/nullable-into-arithmetic"],
  );
});

test("a read that is neither compared nor concatenated is neither rule's business", () => {
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT v_disc;",
  );
  assert.deepEqual(run(nullableVariableInPredicate, src), []);
  assert.deepEqual(run(nullableVariableInConcat, src), []);
});

test("a read that is both arithmetic and negated belongs to the arithmetic rule", () => {
  // `p_order + v_disc != 0` puts one read next to an operator and next to a negation. The NULL
  // escapes through the sum before the comparison ever sees it, so the sum is where to look.
  const src = body(
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  IF p_order + v_disc != 0 THEN SELECT 1; END IF;",
  );
  const found = check(
    new Registry().add(nullableIntoArithmetic, nullableVariableInPredicate),
    { dialect: mysql, catalog: catalogOf(SCHEMA), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => d.code),
    ["routine/nullable-into-arithmetic"],
  );
});

// --------------------------------------------- a DECLARE after the block started working

test("a variable declared where it is needed rather than where it is allowed", () => {
  // The shape a counter added in a hurry takes, halfway down a long procedure. MySQL refuses the
  // routine outright, so what breaks is the deploy.
  const src = body("  SET p_order = 1;", "  DECLARE v_count int;", "  SELECT 1;");
  assert.deepEqual(run(declareAfterStatement, src), [
    "a DECLARE has to come before the block's first statement, or the routine does not parse",
  ]);
});

test("declarations first is the ordinary shape, and is not reported", () => {
  const src = body("  DECLARE v_count int;", "  DECLARE v_total decimal(10,2);", "  SET v_count = 1;");
  assert.deepEqual(run(declareAfterStatement, src), []);
});

test("each BEGIN opens a section of its own", () => {
  // A nested block may declare at its own top, however far down the outer block it sits.
  const src = body("  SET p_order = 1;", "  BEGIN", "    DECLARE v_inner int;", "    SET v_inner = 2;", "  END;");
  assert.deepEqual(run(declareAfterStatement, src), []);
});

test("END IF closes a statement, not the block", () => {
  // If it were read as the block's end, everything after it would be outside any block and the
  // rule would go silent exactly where it is needed.
  const src = body("  IF p_order > 0 THEN", "    SET p_order = 2;", "  END IF;", "  DECLARE v_late int;");
  assert.equal(run(declareAfterStatement, src).length, 1);
});

test("a handler's own body does not count as the block having started", () => {
  const src = body(
    "  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; END;",
    "  DECLARE v_count int;",
    "  SET v_count = 1;",
  );
  assert.deepEqual(run(declareAfterStatement, src), []);
});

// ------------------------------------------- one file, two routines, two sets of variables

test("a variable read in the next routine is still unread in the one that declared it", () => {
  // The engine used to answer this over the whole file, so a name declared here and read *there*
  // looked used. Two procedures share no variables: these are two `v_count`s that happen to be
  // spelled the same.
  const src = [
    "CREATE PROCEDURE sp_first(IN p_a int)",
    "BEGIN",
    "  DECLARE v_count int;",
    "  SET v_count = 1;",
    "END;",
    "CREATE PROCEDURE sp_second(IN p_b int)",
    "BEGIN",
    "  SELECT v_count;",
    "END;",
  ].join("\n");

  assert.deepEqual(run(unusedVariable, src), ["v_count is assigned but never read"]);
});

test("and a taint does not cross into it either", () => {
  // `SELECT nullable INTO v` in one routine said nothing about the `v` of the next one, but the
  // taint was keyed by name over the whole file and reached it anyway.
  const src = [
    "CREATE PROCEDURE sp_first(IN p_order int)",
    "BEGIN",
    "  DECLARE v_disc decimal(10,2);",
    "  SELECT discount INTO v_disc FROM orders WHERE order_id = p_order;",
    "  SELECT v_disc;",
    "END;",
    "CREATE PROCEDURE sp_second(IN p_order int)",
    "BEGIN",
    "  DECLARE v_disc decimal(10,2);",
    "  SET v_disc = 1;",
    "  SELECT v_disc * 2;",
    "END;",
  ].join("\n");

  assert.deepEqual(run(nullableIntoArithmetic, src), []);
});

// ------------------------------------------------------ OUT parameters never filled

/** A header with modes on it, since what this rule reads is the signature. */
function withHeader(header: string, ...lines: string[]): string {
  return [header, "BEGIN", ...lines, "END;"].join("\n");
}

test("an OUT parameter the body never assigns is reported", () => {
  const src = withHeader("CREATE PROCEDURE sp_case(IN p_order int, OUT p_result int)", "  SELECT 1;");
  assert.deepEqual(run(outParamNeverAssigned, src), [
    "p_result is an OUT parameter and sp_case never assigns it, so every caller reads back NULL",
  ]);
});

test("a SET on it is an assignment", () => {
  const src = withHeader("CREATE PROCEDURE sp_case(IN p_order int, OUT p_result int)", "  SET p_result = 1;");
  assert.deepEqual(run(outParamNeverAssigned, src), []);
});

test("so is a SELECT … INTO, which is how most of them are filled", () => {
  const src = withHeader(
    "CREATE PROCEDURE sp_case(IN p_order int, OUT p_result decimal(10,2))",
    "  SELECT total INTO p_result FROM orders WHERE order_id = p_order;",
  );
  assert.deepEqual(run(outParamNeverAssigned, src), []);
});

test("and so is handing it to another procedure's OUT parameter", () => {
  // Which argument that is comes from the callee's signature in the catalog, not from a guess.
  const src = withHeader("CREATE PROCEDURE sp_case(IN p_order int, OUT p_result int)", "  CALL sp_returns(p_order, p_result);");
  assert.deepEqual(run(outParamNeverAssigned, src), []);
});

test("an INOUT parameter is left alone: not assigning it returns the caller's own value", () => {
  // Confirmed against a live server — an `OUT` comes back NULL, an `INOUT` comes back unchanged.
  const src = withHeader("CREATE PROCEDURE sp_case(INOUT p_v int)", "  SELECT p_v;");
  assert.deepEqual(run(outParamNeverAssigned, src), []);
});

test("a parameter a DECLARE shadows is the other rule's finding, not this one's", () => {
  const src = withHeader(
    "CREATE PROCEDURE sp_case(OUT p_result int)",
    "  DECLARE p_result int DEFAULT 0;",
    "  SET p_result = 1;",
  );
  assert.deepEqual(run(outParamNeverAssigned, src), []);
  assert.equal(run(shadowedParameter, src).length, 1);
});

// -------------------------------------------------------------- unknown labels

test("a LEAVE naming a label no block declares is reported", () => {
  const src = body("  wheel: LOOP", "    LEAVE nope;", "  END LOOP wheel;");
  assert.deepEqual(run(unknownLabel, src), ["LEAVE nope: no block in sp_case is labelled nope"]);
});

test("a LEAVE naming the loop it is in is not", () => {
  const src = body("  wheel: LOOP", "    LEAVE wheel;", "  END LOOP wheel;");
  assert.deepEqual(run(unknownLabel, src), []);
});

test("ITERATE is read the same way, and reported the same way", () => {
  const src = body("  wheel: LOOP", "    ITERATE nope;", "  END LOOP wheel;");
  assert.deepEqual(run(unknownLabel, src), ["ITERATE nope: no block in sp_case is labelled nope"]);
});

test("a label folds case like every other identifier", () => {
  const src = body("  Wheel: LOOP", "    LEAVE WHEEL;", "  END LOOP;");
  assert.deepEqual(run(unknownLabel, src), []);
});

test("a labelled BEGIN block is a label too", () => {
  const src = body("  blk: BEGIN", "    LEAVE blk;", "  END;");
  assert.deepEqual(run(unknownLabel, src), []);
});

test("a WHILE and a REPEAT can be labelled, and are", () => {
  const loops = body(
    "  spin: WHILE p_order > 0 DO",
    "    LEAVE spin;",
    "  END WHILE spin;",
    "  again: REPEAT",
    "    ITERATE again;",
    "  UNTIL p_order > 0 END REPEAT again;",
  );
  assert.deepEqual(run(unknownLabel, loops), []);
});

test("a CALL the catalog cannot resolve may be the one filling it, so nothing is claimed", () => {
  // Which argument of a call is `OUT` lives in the callee's signature. Without it there is no way
  // to tell a filled parameter from an unfilled one, and guessing would accuse the caller.
  const src = withHeader("CREATE PROCEDURE sp_case(IN p_order int, OUT p_result int)", "  CALL sp_elsewhere(p_order, p_result);");
  assert.deepEqual(run(outParamNeverAssigned, src), []);
});
