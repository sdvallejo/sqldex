/**
 * The rules that read one statement.
 *
 * The largest group, and the one where the guards do the most work: several of these are only usable
 * because they stand down in a case they cannot decide. So most cases here come in pairs — the one
 * that must go quiet next to the neighbour that must still sound — because a guard nobody checks is
 * a guard that may be silencing the very thing the rule is for.
 *
 * Each rule runs alone, so no case depends on the de-duplication order — except the last one here,
 * which is about exactly that: the single collision `rules/index.ts` documents.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { columnTypeCensus } from "../src/catalog/catalog.ts";
import type { TempTableEntry } from "../src/catalog/catalog.ts";
import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Routine } from "../src/model/routine.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { Rule, RuleCatalog } from "../src/rules/rule.ts";
import {
  callArity,
  collationMismatch,
  insertUnknownColumn,
  insertValueCount,
  joinWithoutCondition,
  leftJoinArithmetic,
  outArgumentNotVariable,
  unfilteredWrite,
  unknownAlias,
  unknownColumn,
  unknownRoutine,
  unknownTable,
  unqualifiedColumn,
} from "../src/rules/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import { parseHeader } from "../src/syntax/fast/routine.ts";

const SCHEMA = [
  "CREATE TABLE orders (",
  "  order_id int NOT NULL,",
  "  customer_id int NOT NULL,",
  "  status char(1) NOT NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  PRIMARY KEY (order_id)",
  ");",
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  label varchar(40) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
  "CREATE TABLE refunds (",
  "  refund_id int NOT NULL,",
  "  order_id int NOT NULL,",
  "  amount decimal(10,2) NULL,",
  "  PRIMARY KEY (refund_id)",
  ");",
  // A pair on different collations, which is the only thing the collation rule looks at.
  "CREATE TABLE current_codes (code varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL);",
  "CREATE TABLE legacy_codes (code varchar(10) COLLATE utf8_spanish_ci NOT NULL);",
  // A generated column, so a positional INSERT may pass it DEFAULT or leave it out.
  "CREATE TABLE events (",
  "  event_id int NOT NULL,",
  "  payload varchar(80) NOT NULL,",
  "  summary varchar(80) AS (LEFT(payload, 10)) STORED,",
  "  PRIMARY KEY (event_id)",
  ");",
].join("\n");

const ROUTINES = [
  "CREATE PROCEDURE sp_known() BEGIN SELECT 1; END;",
  "CREATE PROCEDURE sp_three(IN p_a int, IN p_b int, IN p_c int) BEGIN SELECT 1; END;",
  "CREATE PROCEDURE sp_returns(IN p_in int, OUT p_out int) BEGIN SET p_out = p_in; END;",
].join("\n");

/** A temporary table another procedure created, which is the ordinary case. */
const TEMP: TempTableEntry = {
  name: "tmp_from_other_sp",
  file: "/nowhere/other.sql",
  columns: ["batch_id", "total"],
};

function catalogOf(): RuleCatalog {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, SCHEMA, tokenize(SCHEMA)).tables) {
    if (!table.temporary) tables.set(table.name.toLowerCase(), table);
  }
  const routines = new Map<string, Routine>();
  for (const routine of parseHeader(ROUTINES)) routines.set(routine.name.toLowerCase(), routine);

  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: (name) => (name === undefined ? undefined : routines.get(name.toLowerCase())),
    trigger: () => undefined,
    tempTable: (name) => (name?.toLowerCase() === TEMP.name ? TEMP : undefined),
    columnTypes: () => columnTypeCensus(mysql, tables),
  };
}

function run(rule: Rule, src: string): string[] {
  return check(
    new Registry().add(rule),
    { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
    src,
  ).map((d) => d.message);
}

/** Wraps a body in a procedure, so its `DECLARE`s are locals. */
function body(...lines: string[]): string {
  return ["CREATE PROCEDURE sp_case(IN p_id int)", "BEGIN", ...lines, "END;"].join("\n");
}

// ------------------------------------------------------------- unknown tables

test("a relation the catalog does not have is reported", () => {
  assert.deepEqual(run(unknownTable, "SELECT * FROM ordrs;"), ["unknown table: ordrs"]);
});

test("a temporary table another procedure created is not unknown", () => {
  // The ordinary pattern is one procedure creating it and another querying it after a CALL, so a
  // per-file view of temporary tables would flag most of the second procedure.
  assert.deepEqual(run(unknownTable, "SELECT * FROM tmp_from_other_sp;"), []);
});

test("a temporary table this file creates is not unknown either", () => {
  const src = body(
    "  CREATE TEMPORARY TABLE tmp_here (id int);",
    "  SELECT * FROM tmp_here;",
  );
  assert.deepEqual(run(unknownTable, src), []);
});

test("a common table expression is defined by the statement, not by the catalog", () => {
  const src = "WITH recent AS (SELECT order_id FROM orders) SELECT * FROM recent;";
  assert.deepEqual(run(unknownTable, src), []);
});

test("a derived table has no name to check", () => {
  assert.deepEqual(run(unknownTable, "SELECT * FROM (SELECT 1 AS n) x;"), []);
});

test("a reference into a schema the engine owns is not this repo's to define", () => {
  assert.deepEqual(run(unknownTable, "SELECT * FROM information_schema.tables;"), []);
});

// ------------------------------------------------------------ unknown aliases

test("a qualifier nothing declares is reported", () => {
  assert.deepEqual(run(unknownAlias, "SELECT z.total FROM orders o;"), ["unknown alias: z"]);
});

test("an alias the statement declares is never unknown, even pointing at something unresolvable", () => {
  // "I cannot tell which table this is" and "that alias does not exist" are different claims.
  assert.deepEqual(run(unknownAlias, "SELECT t.whatever FROM tmp_from_other_sp t;"), []);
});

test("a schema qualifier is recognised by what follows the dot being a table", () => {
  assert.deepEqual(run(unknownAlias, "SELECT shop.orders.total FROM shop.orders;"), []);
});

test("a server variable is not a qualifier", () => {
  assert.deepEqual(run(unknownAlias, "SELECT @cfg.value FROM orders o;"), []);
});

// ------------------------------------------------------------ unknown columns

test("a qualified column the table does not have is reported", () => {
  assert.deepEqual(run(unknownColumn, "SELECT o.totl FROM orders o;"), [
    "orders has no column totl",
  ]);
});

test("nothing is claimed about a temporary table's columns", () => {
  assert.deepEqual(run(unknownColumn, "SELECT t.whatever FROM tmp_from_other_sp t;"), []);
});

test("nor about a derived table's", () => {
  assert.deepEqual(run(unknownColumn, "SELECT x.whatever FROM (SELECT 1 AS n) x;"), []);
});

test("NEW and OLD are checked against the trigger's own table", () => {
  const src = [
    "CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW BEGIN",
    "  SET @x = NEW.totl;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(unknownColumn, src), ["orders has no column totl"]);
});

// ----------------------------------------------------------- CALL: name, arity

test("a CALL to a routine nothing defines is reported", () => {
  assert.deepEqual(run(unknownRoutine, body("  CALL sp_missing(1);")), [
    "unknown routine: sp_missing",
  ]);
});

test("the wrong number of arguments is an error", () => {
  assert.deepEqual(run(callArity, body("  CALL sp_three(1, 2);")), [
    "sp_three expects 3 argument(s) and gets 2",
  ]);
});

test("CALL without parentheses is valid, but only with no parameters", () => {
  assert.deepEqual(run(callArity, body("  CALL sp_known;")), []);
  assert.deepEqual(run(callArity, body("  CALL sp_three;")), [
    "sp_three expects 3 argument(s) and is called with none",
  ]);
});

test("no signature means nothing to count against", () => {
  assert.deepEqual(run(callArity, body("  CALL sp_missing(1, 2, 3);")), []);
});

test("f() is zero arguments, not one", () => {
  assert.deepEqual(run(callArity, body("  CALL sp_known();")), []);
});

// ------------------------------------------------------ CALL: OUT arguments

test("a literal in an OUT position cannot be written to", () => {
  assert.deepEqual(run(outArgumentNotVariable, body("  CALL sp_returns(1, 2);")), [
    "argument 2 of sp_returns is OUT and must be a variable",
  ]);
});

test("an expression in an OUT position likewise", () => {
  assert.deepEqual(run(outArgumentNotVariable, body("  CALL sp_returns(1, 2 + 3);")), [
    "argument 2 of sp_returns is OUT and must be a variable",
  ]);
});

test("a bare identifier the analysis does not recognise is left alone", () => {
  // Far likelier to be a scope this missed than a real defect, and this rule reports errors.
  assert.deepEqual(run(outArgumentNotVariable, body("  CALL sp_returns(1, v_unknown);")), []);
});

test("NULL is not assignable, keyword or not", () => {
  assert.deepEqual(run(outArgumentNotVariable, body("  CALL sp_returns(1, NULL);")), [
    "argument 2 of sp_returns is OUT and must be a variable",
  ]);
});

test("with the wrong argument count the slots do not line up, so it stands down", () => {
  assert.deepEqual(run(outArgumentNotVariable, body("  CALL sp_returns(1);")), []);
});

// ---------------------------------------------------------------- INSERT

test("a column named in an INSERT's list that the table lacks is an error", () => {
  assert.deepEqual(run(insertUnknownColumn, "INSERT INTO orders (order_id, totl) VALUES (1, 2);"), [
    "orders has no column totl",
  ]);
});

test("the parenthesis of INSERT INTO t (SELECT ...) is not a column list", () => {
  const src = "INSERT INTO orders (SELECT order_id, customer_id, status, total FROM orders);";
  assert.deepEqual(run(insertUnknownColumn, src), []);
});

test("a value count that does not match the column list is an error", () => {
  assert.deepEqual(run(insertValueCount, "INSERT INTO orders (order_id, status) VALUES (1, 'A', 9);"), [
    "orders gets 3 value(s) and expects 2",
  ]);
});

test("without a column list the count is against the table", () => {
  assert.deepEqual(run(insertValueCount, "INSERT INTO orders VALUES (1, 2, 'A');"), [
    "orders gets 3 value(s) and expects 4",
  ]);
});

test("a generated column may be passed DEFAULT or left out, so both counts are accepted", () => {
  assert.deepEqual(run(insertValueCount, "INSERT INTO events VALUES (1, 'x', DEFAULT);"), []);
  assert.deepEqual(run(insertValueCount, "INSERT INTO events VALUES (1, 'x');"), []);
  assert.deepEqual(run(insertValueCount, "INSERT INTO events VALUES (1);"), [
    "events gets 1 value(s) and expects 3",
  ]);
});

test("each tuple of a multi-row INSERT is checked on its own", () => {
  const src = "INSERT INTO orders (order_id, status) VALUES (1, 'A'), (2), (3, 'C');";
  assert.deepEqual(run(insertValueCount, src), ["orders gets 1 value(s) and expects 2"]);
});

// -------------------------------------------------------- unqualified columns

test("a bare name no table in the query has is reported", () => {
  assert.deepEqual(run(unqualifiedColumn, "SELECT order_id FROM orders WHERE totl = 1;"), [
    "unknown column: totl",
  ]);
});

test("it stands down entirely when any relation did not resolve", () => {
  // This is the guard that makes the rule usable: with a temporary table in the mix the set of valid
  // columns is unknown, and claiming a name is not among them would be guessing.
  const src = "SELECT order_id FROM orders o JOIN tmp_from_other_sp t ON t.batch_id = o.order_id WHERE totl = 1;";
  assert.deepEqual(run(unqualifiedColumn, src), []);
});

test("an alias of the statement is not a column", () => {
  assert.deepEqual(run(unqualifiedColumn, "SELECT o.total FROM orders o;"), []);
});

test("an output name the SELECT defines is not a column, and ORDER BY may use it", () => {
  const src = "SELECT total * 2 AS net FROM orders ORDER BY net;";
  assert.deepEqual(run(unqualifiedColumn, src), []);
});

test("a WITH name is defined by the statement", () => {
  const src = "WITH recent AS (SELECT order_id FROM orders) SELECT order_id FROM recent;";
  assert.deepEqual(run(unqualifiedColumn, src), []);
});

test("a reserved word is not a column, unless it was written delimited", () => {
  assert.deepEqual(run(unqualifiedColumn, "SELECT order_id FROM orders WHERE status IS NOT NULL;"), []);
});

// ------------------------------------------------------- LEFT JOIN arithmetic

test("a LEFT JOIN column in arithmetic with nothing absorbing the NULL is reported", () => {
  const src = "SELECT o.total - r.amount FROM orders o LEFT JOIN refunds r ON r.order_id = o.order_id;";
  assert.deepEqual(run(leftJoinArithmetic, src), [
    "r.amount can be NULL because of the LEFT JOIN; without COALESCE the whole expression is NULL",
  ]);
});

test("COALESCE is the fix, and it is recognised as one", () => {
  const src =
    "SELECT o.total - COALESCE(r.amount, 0) FROM orders o LEFT JOIN refunds r ON r.order_id = o.order_id;";
  assert.deepEqual(run(leftJoinArithmetic, src), []);
});

test("an inner join's column cannot be missing, so it is not reported", () => {
  const src = "SELECT o.total - r.amount FROM orders o JOIN refunds r ON r.order_id = o.order_id;";
  assert.deepEqual(run(leftJoinArithmetic, src), []);
});

test("a LEFT JOIN column not in arithmetic is a different question", () => {
  const src = "SELECT r.amount FROM orders o LEFT JOIN refunds r ON r.order_id = o.order_id;";
  assert.deepEqual(run(leftJoinArithmetic, src), []);
});

// ------------------------------------------------------------ collations

test("a join across two collations is reported", () => {
  const src = "SELECT 1 FROM current_codes n JOIN legacy_codes v ON n.code = v.code;";
  assert.deepEqual(run(collationMismatch, src), [
    "n.code is utf8mb4_unicode_ci and v.code is utf8_spanish_ci: the comparison cannot use the index",
  ]);
});

test("two columns of the same collation are silent, whatever that collation is", () => {
  const src = "SELECT 1 FROM current_codes a JOIN current_codes b ON a.code = b.code;";
  assert.deepEqual(run(collationMismatch, src), []);
});

test("a column against a literal is a different question", () => {
  assert.deepEqual(run(collationMismatch, "SELECT 1 FROM legacy_codes v WHERE v.code = 'x';"), []);
});

// -------------------------------------------------------- unfiltered writes

test("an UPDATE with nothing to narrow it is reported", () => {
  assert.deepEqual(run(unfilteredWrite, "UPDATE orders SET total = 0;"), [
    "this UPDATE has no filter: it rewrites the whole of orders",
  ]);
});

test("and a DELETE reads as emptying rather than rewriting", () => {
  assert.deepEqual(run(unfilteredWrite, "DELETE FROM orders;"), [
    "this DELETE has no filter: it empties the whole of orders",
  ]);
});

test("a WHERE, a JOIN, a USING or a LIMIT all narrow it", () => {
  assert.deepEqual(run(unfilteredWrite, "UPDATE orders SET total = 0 WHERE order_id = 1;"), []);
  assert.deepEqual(
    run(unfilteredWrite, "UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id SET o.total = 0;"),
    [],
  );
  assert.deepEqual(run(unfilteredWrite, "DELETE FROM orders LIMIT 10;"), []);
});

test("a temporary table is emptied wholesale on purpose", () => {
  assert.deepEqual(run(unfilteredWrite, "DELETE FROM tmp_from_other_sp;"), []);
});

test("the WHERE of a subquery narrows the subquery, not this statement", () => {
  const src = "DELETE FROM orders WHERE order_id IN (SELECT order_id FROM refunds WHERE amount > 0);";
  assert.deepEqual(run(unfilteredWrite, src), [], "that one is at depth zero and does narrow it");
  const nested = "UPDATE orders SET total = (SELECT amount FROM refunds WHERE refund_id = 1);";
  assert.deepEqual(run(unfilteredWrite, nested), [
    "this UPDATE has no filter: it rewrites the whole of orders",
  ]);
});

// ------------------------------------------------------ joins with no condition

test("a JOIN between two schema tables with no condition is a cartesian product", () => {
  assert.deepEqual(run(joinWithoutCondition, "SELECT 1 FROM orders o JOIN customers c;"), [
    "this JOIN with customers has no ON or USING: it is a cartesian product",
  ]);
});

test("the condition is found past a subquery, however far below it sits", () => {
  // A fixed lookahead never reaches the ON of `LEFT JOIN (SELECT ...) x ON ...`.
  const src =
    "SELECT 1 FROM orders o LEFT JOIN (SELECT order_id, amount FROM refunds WHERE amount > 0 AND order_id > 0) x " +
    "ON x.order_id = o.order_id;";
  assert.deepEqual(run(joinWithoutCondition, src), []);
});

test("joining something the procedure built itself is a choice, not a defect", () => {
  const src = "SELECT 1 FROM orders o JOIN tmp_from_other_sp t;";
  assert.deepEqual(run(joinWithoutCondition, src), []);
});

test("and the left-hand side has to be a schema table too", () => {
  const src = "SELECT 1 FROM tmp_from_other_sp t JOIN orders o;";
  assert.deepEqual(run(joinWithoutCondition, src), []);
});

test("CROSS JOIN and NATURAL JOIN are valid with no condition", () => {
  assert.deepEqual(run(joinWithoutCondition, "SELECT 1 FROM orders o CROSS JOIN customers c;"), []);
  assert.deepEqual(run(joinWithoutCondition, "SELECT 1 FROM orders o NATURAL JOIN customers c;"), []);
});

test("USING counts as a condition just as ON does", () => {
  assert.deepEqual(run(joinWithoutCondition, "SELECT 1 FROM orders o JOIN customers c USING (customer_id);"), []);
});

// ------------------------------------------------------------ the one collision

test("an INSERT's unknown column is claimed by the insert rule, not the bare-column one", () => {
  // Both rules can see that token. The insert rule says which table it is missing from, which is the
  // more useful thing, so it is registered first — and this is what holds that order down.
  const src = "INSERT INTO orders (order_id, totl) VALUES (1, 2);";
  const found = check(
    new Registry().add(insertUnknownColumn, unqualifiedColumn),
    { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => `${d.code}: ${d.message}`),
    ["query/insert-unknown-column: orders has no column totl"],
  );
});
