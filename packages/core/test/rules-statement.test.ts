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
  joinMultipliesAggregate,
  joinWithoutCondition,
  leftJoinArithmetic,
  literalTypeMismatch,
  nullableScalarSubquery,
  onlyFullGroupBy,
  outArgumentNotVariable,
  scalarSubqueryManyRows,
  selectIntoManyRows,
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
  // Many rows per order, keyed by a pair: what a join to it multiplies, and what a `WHERE` on the
  // second half of the key stops multiplying.
  "CREATE TABLE order_lines (",
  "  order_id int NOT NULL,",
  "  line_no int NOT NULL,",
  "  amount decimal(10,2) NOT NULL,",
  "  PRIMARY KEY (order_id, line_no)",
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
    tables,
    index: (_key, build) => build(tables),
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

// ------------------------------------------------- an aggregate multiplied by a join

test("a SUM over one table's column, joined to a table where the key is not unique", () => {
  assert.deepEqual(run(joinMultipliesAggregate, "SELECT SUM(o.total) FROM orders o JOIN refunds r USING(order_id);"), [
    "SUM over o.total is multiplied by the join to refunds: order_id is not unique there",
  ]);
});

test("the same join written with ON, either way round", () => {
  const on = "SELECT SUM(o.total) FROM orders o JOIN refunds r ON r.order_id = o.order_id;";
  const flipped = "SELECT SUM(o.total) FROM orders o JOIN refunds r ON o.order_id = r.order_id;";
  assert.equal(run(joinMultipliesAggregate, on).length, 1);
  assert.deepEqual(run(joinMultipliesAggregate, flipped), run(joinMultipliesAggregate, on));
});

test("a join on a unique key brings back one row, so nothing is multiplied", () => {
  assert.deepEqual(
    run(joinMultipliesAggregate, "SELECT SUM(o.total) FROM orders o JOIN customers c USING(customer_id);"),
    [],
  );
});

test("the joined table's own columns are not repeated: they are what the join returned", () => {
  assert.deepEqual(run(joinMultipliesAggregate, "SELECT SUM(r.amount) FROM orders o JOIN refunds r USING(order_id);"), []);
});

test("MIN and MAX cannot see a repeated row", () => {
  assert.deepEqual(run(joinMultipliesAggregate, "SELECT MAX(o.total) FROM orders o JOIN refunds r USING(order_id);"), []);
});

test("COUNT(DISTINCT …) is how somebody who knew wrote around it", () => {
  assert.deepEqual(
    run(joinMultipliesAggregate, "SELECT COUNT(DISTINCT o.order_id) FROM orders o JOIN refunds r USING(order_id);"),
    [],
  );
});

test("an anti-join keeps the rows that matched nothing, which cannot be several", () => {
  // The standard way to write "orders with no refund". Reporting it would be the fastest way to
  // get the rule turned off.
  assert.deepEqual(
    run(
      joinMultipliesAggregate,
      "SELECT SUM(o.total) FROM orders o LEFT JOIN refunds r USING(order_id) WHERE r.refund_id IS NULL;",
    ),
    [],
  );
});

test("a WHERE that finishes the key stops the multiplication, and without it the finding stands", () => {
  const pinned = "SELECT SUM(o.total) FROM orders o JOIN order_lines l USING(order_id) WHERE l.line_no = 1;";
  const loose = "SELECT SUM(o.total) FROM orders o JOIN order_lines l USING(order_id);";
  assert.deepEqual(run(joinMultipliesAggregate, pinned), []);
  assert.deepEqual(run(joinMultipliesAggregate, loose), [
    "SUM over o.total is multiplied by the join to order_lines: order_id is not unique there",
  ]);
});

test("half of a two-column key is not the key", () => {
  // `line_no` alone leaves the order free, so the rows are still a group.
  assert.equal(
    run(joinMultipliesAggregate, "SELECT SUM(o.total) FROM orders o JOIN order_lines l ON l.line_no = 1;").length,
    1,
  );
});

test("a reference that is only a test is not what gets added up", () => {
  assert.deepEqual(
    run(
      joinMultipliesAggregate,
      "SELECT SUM(IF(o.status = 'P', r.amount, 0)) FROM orders o JOIN refunds r USING(order_id);",
    ),
    [],
  );
});

test("a condition it cannot read as equalities is left alone", () => {
  assert.deepEqual(
    run(
      joinMultipliesAggregate,
      "SELECT SUM(o.total) FROM orders o JOIN refunds r ON r.order_id = o.order_id OR r.refund_id = 0;",
    ),
    [],
  );
});

test("one statement's two queries are not each other's business", () => {
  // A `SET` holding two subqueries is one statement and two queries. Blaming the first one's SUM for
  // the second one's join is exactly what a statement-wide view of the relations would do.
  assert.deepEqual(
    run(
      joinMultipliesAggregate,
      body("  SET p_id = (SELECT SUM(o.total) FROM orders o) + (SELECT COUNT(r.amount) FROM refunds r);"),
    ),
    [],
  );
});

test("a subquery inside the aggregate belongs to itself", () => {
  // The parentheses of a `SUM` can hold a whole query, and a name in there is not multiplied by a
  // join out here.
  assert.deepEqual(
    run(
      joinMultipliesAggregate,
      body("  SET p_id = (SELECT SUM((SELECT COUNT(*) FROM refunds x WHERE x.order_id = c.customer_id)) FROM customers c);"),
    ),
    [],
  );
});

// ------------------------------------------- a subquery that is NULL when it finds nothing

test("an unwrapped aggregate in a subquery used as a number", () => {
  assert.deepEqual(
    run(
      nullableScalarSubquery,
      "SELECT o.total - (SELECT SUM(r.amount) FROM refunds r WHERE r.order_id = o.order_id) FROM orders o;",
    ),
    [
      "SUM is NULL when it aggregates no rows, and that NULL becomes the whole expression: " +
        "wrap it in COALESCE inside the subquery",
    ],
  );
});

test("the same aggregate wrapped inside the subquery is the fix, and is not reported", () => {
  assert.deepEqual(
    run(
      nullableScalarSubquery,
      "SELECT o.total - (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.order_id = o.order_id) FROM orders o;",
    ),
    [],
  );
});

test("a COALESCE around the whole expression does not protect it — it is what hides the defect", () => {
  // The one place in the engine where a null-safe wrapper is read as an aggravating circumstance:
  // the NULL is not absorbed, it is turned into a confident zero.
  const src = body("  SET p_id = COALESCE(p_id + (SELECT SUM(r.amount) FROM refunds r WHERE r.order_id = 1), 0);");
  assert.equal(run(nullableScalarSubquery, src).length, 1);
});

test("COUNT answers an empty set with a number, so arithmetic on it is safe", () => {
  assert.deepEqual(
    run(nullableScalarSubquery, "SELECT 1 + (SELECT COUNT(*) FROM refunds r WHERE r.order_id = 1);"),
    [],
  );
});

test("each aggregate of an item is judged on its own", () => {
  const both = "SELECT 1 + (SELECT COALESCE(SUM(r.amount), 0) - COALESCE(MAX(r.amount), 0) FROM refunds r);";
  const half = "SELECT 1 + (SELECT COALESCE(SUM(r.amount), 0) - MAX(r.amount) FROM refunds r);";
  assert.deepEqual(run(nullableScalarSubquery, both), []);
  assert.equal(run(nullableScalarSubquery, half).length, 1);
});

test("a search that pins half a key can find nothing, and a lookup of the whole key cannot", () => {
  const search = "SELECT o.total + (SELECT l.amount FROM order_lines l WHERE l.order_id = o.order_id) FROM orders o;";
  const lookup =
    "SELECT o.total + (SELECT l.amount FROM order_lines l WHERE l.order_id = o.order_id AND l.line_no = 1) FROM orders o;";
  assert.deepEqual(run(nullableScalarSubquery, search), [
    "this subquery is NULL when it matches no row, and that NULL becomes the whole expression",
  ]);
  assert.deepEqual(run(nullableScalarSubquery, lookup), []);
});

test("an unqualified lookup is a lookup: over one table there is nothing else the name could be", () => {
  assert.deepEqual(
    run(nullableScalarSubquery, "SELECT 1 + (SELECT total FROM orders WHERE order_id = 7);"),
    [],
  );
});

test("a join can eliminate the row the key found, so it is no longer a lookup", () => {
  assert.equal(
    run(
      nullableScalarSubquery,
      "SELECT 1 + (SELECT l.amount FROM order_lines l JOIN orders o USING (order_id) WHERE l.order_id = 7 AND l.line_no = 1);",
    ).length,
    1,
  );
});

test("a GROUP BY can leave an aggregate with no group to answer for", () => {
  assert.equal(
    run(
      nullableScalarSubquery,
      "SELECT 1 + (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.order_id = 7 GROUP BY r.order_id);",
    ).length,
    1,
  );
});

test("a SELECT with no FROM computes its row out of nothing", () => {
  assert.deepEqual(run(nullableScalarSubquery, "SELECT 1 + (SELECT MAX(1));"), []);
});

test("only an operand: an assignment straight from a subquery leaves the NULL where it can be seen", () => {
  // `SET v = (SELECT SUM(…))` is a NULL in `v`, which is visible. Folded into a sum it is not, and
  // that is the difference the rule is drawn on.
  assert.deepEqual(
    run(nullableScalarSubquery, body("  SET p_id = (SELECT SUM(r.amount) FROM refunds r WHERE r.order_id = 1);")),
    [],
  );
  assert.deepEqual(
    run(nullableScalarSubquery, "SELECT o.order_id FROM orders o WHERE o.order_id IN (SELECT r.order_id FROM refunds r);"),
    [],
  );
});

test("an aggregate that is both multiplied by a join and NULL over nothing belongs to the join rule", () => {
  // Both rules report on the aggregate's own name token. The fan-out says which join multiplies it
  // and which key is not unique there, so it is registered first; this is what holds that order.
  const src = body("  SET p_id = (SELECT SUM(o.total) FROM orders o JOIN refunds r USING(order_id)) + 1;");
  const found = check(
    new Registry().add(joinMultipliesAggregate, nullableScalarSubquery),
    { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => d.code),
    ["query/join-multiplies-aggregate"],
  );
});

// ------------------------------------------- a subquery that can come back with several rows

test("a search that starts a key and abandons it can match twice", () => {
  assert.deepEqual(
    run(scalarSubqueryManyRows, "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7);"),
    [
      "this subquery can return more than one row: order_lines is keyed on (order_id, line_no), and " +
        "this fixes order_id but leaves line_no free. MySQL answers error 1242 rather than a value",
    ],
  );
});

test("the whole key finishes the search, and half of it does not", () => {
  const whole = "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 AND l.line_no = 1);";
  const half = "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.line_no = 1);";
  assert.deepEqual(run(scalarSubqueryManyRows, whole), []);
  assert.equal(run(scalarSubqueryManyRows, half).length, 1);
});

test("a search that touches no key at all is one the schema has no opinion about", () => {
  // `status` is in no unique index. It may well be unique in this data, and the schema does not say
  // — so reporting it would be arguing about somebody's rows rather than reading their DDL.
  assert.deepEqual(run(scalarSubqueryManyRows, "SELECT 1 + (SELECT o.total FROM orders o WHERE o.status = 'A');"), []);
});

test("an aggregate folds the group into one row, unless a GROUP BY hands back one per group", () => {
  const folded = "SELECT 1 + (SELECT SUM(l.amount) FROM order_lines l WHERE l.order_id = 7);";
  const grouped = "SELECT 1 + (SELECT SUM(l.amount) FROM order_lines l WHERE l.order_id = 7 GROUP BY l.line_no);";
  assert.deepEqual(run(scalarSubqueryManyRows, folded), []);
  assert.equal(run(scalarSubqueryManyRows, grouped).length, 1);
});

test("LIMIT 1 is the author saying any one of them will do", () => {
  assert.deepEqual(
    run(scalarSubqueryManyRows, "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 LIMIT 1);"),
    [],
  );
  assert.equal(
    run(scalarSubqueryManyRows, "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 LIMIT 2);").length,
    1,
  );
});

test("the operators built for many rows are not misread as asking for one", () => {
  const inList = "SELECT o.order_id FROM orders o WHERE o.order_id IN (SELECT l.order_id FROM order_lines l WHERE l.order_id = 7);";
  const exists = "SELECT o.order_id FROM orders o WHERE EXISTS (SELECT l.amount FROM order_lines l WHERE l.order_id = 7);";
  assert.deepEqual(run(scalarSubqueryManyRows, inList), []);
  assert.deepEqual(run(scalarSubqueryManyRows, exists), []);
});

test("a derived table is a query, not a value", () => {
  assert.deepEqual(
    run(scalarSubqueryManyRows, "SELECT x.amount FROM (SELECT l.amount FROM order_lines l WHERE l.order_id = 7) x;"),
    [],
  );
});

test("a key covered whole silences it even when another key has a column to spare", () => {
  // `refunds` is keyed on `refund_id`; a query that fixes it is one row, and no other index matters.
  assert.deepEqual(run(scalarSubqueryManyRows, "SELECT 1 + (SELECT r.amount FROM refunds r WHERE r.refund_id = 3);"), []);
});

test("a table the catalog does not have cannot support the claim", () => {
  assert.deepEqual(run(scalarSubqueryManyRows, "SELECT 1 + (SELECT t.total FROM tmp_from_other_sp t);"), []);
});

test("an unpinned search read as a number belongs to the many-rows rule, not the NULL one", () => {
  // Both see the same `SELECT` token, and both come of the same missing key. Pinning it answers
  // both; a COALESCE around the sum leaves the statement still able to fail with 1242.
  const src = "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7);";
  const found = check(
    new Registry().add(scalarSubqueryManyRows, nullableScalarSubquery),
    { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => d.code),
    ["query/scalar-subquery-many-rows"],
  );
});

// ------------------------------------------ a SELECT … INTO that can match twice

test("a SELECT INTO whose WHERE starts a key and abandons it", () => {
  const src = body("  SELECT l.amount INTO p_id FROM order_lines l WHERE l.order_id = 7;");
  assert.deepEqual(run(selectIntoManyRows, src), [
    "this SELECT can match more than one row: order_lines is keyed on (order_id, line_no), and this " +
      "fixes order_id but leaves line_no free. MySQL answers error 1172 rather than filling the variables",
  ]);
});

test("the same three things that make one row certain, in the other place a routine reads one", () => {
  // The whole key, an aggregate, and a LIMIT: each is enough on its own, and they are the same
  // three `query/scalar-subquery-many-rows` asks, answered by the same code.
  const whole = "  SELECT l.amount INTO p_id FROM order_lines l WHERE l.order_id = 7 AND l.line_no = 1;";
  const folded = "  SELECT SUM(l.amount) INTO p_id FROM order_lines l WHERE l.order_id = 7;";
  const limited = "  SELECT l.amount INTO p_id FROM order_lines l WHERE l.order_id = 7 LIMIT 1;";
  for (const statement of [whole, folded, limited]) {
    assert.deepEqual(run(selectIntoManyRows, body(statement)), [], statement);
  }
});

test("a search the schema has no opinion about, and one it cannot read at all", () => {
  const noKey = body("  SELECT o.total INTO p_id FROM orders o WHERE o.status = 'A';");
  const joined = body("  SELECT l.amount INTO p_id FROM order_lines l JOIN orders o USING (order_id) WHERE l.order_id = 7;");
  const temp = body("  SELECT t.total INTO p_id FROM tmp_from_other_sp t;");
  assert.deepEqual(run(selectIntoManyRows, noKey), []);
  assert.deepEqual(run(selectIntoManyRows, temp), []);
  // A join is a claim this cannot make either way: the second table decides how many rows come back.
  assert.deepEqual(run(selectIntoManyRows, joined), []);
});

test("INTO OUTFILE takes as many rows as it finds, which is what it is for", () => {
  const src = body("  SELECT l.amount INTO OUTFILE '/tmp/x' FROM order_lines l WHERE l.order_id = 7;");
  assert.deepEqual(run(selectIntoManyRows, src), []);
});

// ------------------------------------------------ a column neither grouped nor aggregated

test("a column outside the grouping is one the server either refuses or answers arbitrarily", () => {
  assert.deepEqual(run(onlyFullGroupBy, "SELECT o.status, COUNT(*) FROM orders o GROUP BY o.customer_id;"), [
    "o.status is neither grouped nor aggregated: a server with ONLY_FULL_GROUP_BY refuses this, " +
      "and one without it returns an arbitrary row's value",
  ]);
});

test("grouping by the key determines every column of that table, which is what makes this usable", () => {
  // The ordinary report shape. Without reading the key out of the DDL, this is the case a naive
  // reading of the clause reports, and it is correct SQL that the server accepts.
  assert.deepEqual(
    run(onlyFullGroupBy, "SELECT o.status, o.total, COUNT(*) FROM orders o GROUP BY o.order_id;"),
    [],
  );
});

test("and it reaches a table joined to a determined one by its own key", () => {
  const src =
    "SELECT c.label, COUNT(*) FROM orders o JOIN customers c ON c.customer_id = o.customer_id GROUP BY o.order_id;";
  assert.deepEqual(run(onlyFullGroupBy, src), []);
  // The same query grouped by something that determines nothing still sounds.
  const loose =
    "SELECT c.label, COUNT(*) FROM orders o JOIN customers c ON c.customer_id = o.customer_id GROUP BY o.status;";
  assert.equal(run(onlyFullGroupBy, loose).length, 1);
});

test("a USING join carries the same determination as an ON equality", () => {
  const src = "SELECT l.amount, COUNT(*) FROM order_lines l JOIN orders o USING (order_id) GROUP BY o.order_id, l.line_no;";
  assert.deepEqual(run(onlyFullGroupBy, src), []);
});

test("what a select item is called is not a column of anything", () => {
  // `expr AS x` and the bare `expr x`, which these files use interchangeably.
  const named = "SELECT CONCAT(o.status, '!') AS flag, COUNT(*) FROM orders o GROUP BY o.order_id;";
  const bare = "SELECT CONCAT(o.status, '!') flag, COUNT(*) FROM orders o GROUP BY o.order_id;";
  assert.deepEqual(run(onlyFullGroupBy, named), []);
  assert.deepEqual(run(onlyFullGroupBy, bare), []);
});

test("an expression grouped by as written is grouped, and the clause may name the item instead", () => {
  const verbatim = "SELECT LEFT(o.status, 1), COUNT(*) FROM orders o GROUP BY LEFT(o.status, 1);";
  const byLabel = "SELECT LEFT(o.status, 1) AS s, COUNT(*) FROM orders o GROUP BY s;";
  assert.deepEqual(run(onlyFullGroupBy, verbatim), []);
  assert.deepEqual(run(onlyFullGroupBy, byLabel), []);
});

test("an aggregate with no grouping at all makes the rest of the list arbitrary", () => {
  assert.equal(run(onlyFullGroupBy, "SELECT o.status, COUNT(*) FROM orders o;").length, 1);
  // …and an ordinary select, which is neither grouped nor aggregated, is not this rule's business.
  assert.deepEqual(run(onlyFullGroupBy, "SELECT o.status, o.total FROM orders o;"), []);
});

test("the variables of a SELECT … INTO are not columns of the query", () => {
  // They sit before the `FROM`, so a select list cut at the wrong clause reads them as columns and
  // reports every procedure that counts something into a variable.
  const src = body("  SELECT COUNT(*) INTO p_id FROM orders o GROUP BY o.status;");
  assert.deepEqual(run(onlyFullGroupBy, src), []);
});

test("a star says nothing about which columns those are", () => {
  assert.deepEqual(run(onlyFullGroupBy, "SELECT *, COUNT(*) FROM orders o GROUP BY o.status;"), []);
});

// ------------------------------------------- a column compared against another type of literal

test("a text column compared with a number is converted, once per row", () => {
  assert.equal(run(literalTypeMismatch, "SELECT * FROM orders o WHERE o.status = 1;").length, 1);
  assert.deepEqual(run(literalTypeMismatch, "SELECT * FROM orders o WHERE o.status = 'A';"), []);
});

test("a numeric column compared with a string is fine when the string is a number", () => {
  // MySQL converts the literal, not the column: the index still works and the answer is the one
  // intended. `'A'` is a different thing — it reads as 0, and the query finds nothing.
  assert.deepEqual(run(literalTypeMismatch, "SELECT * FROM orders o WHERE o.order_id = '5';"), []);
  assert.equal(run(literalTypeMismatch, "SELECT * FROM orders o WHERE o.order_id = 'A';").length, 1);
});

test("a bare column is read when this query has one owner for it", () => {
  assert.equal(run(literalTypeMismatch, "SELECT * FROM orders WHERE status = 1;").length, 1);
});

test("a comparison against anything but a literal is not this rule's business", () => {
  const src = body("  SELECT o.total FROM orders o WHERE o.status = p_id;");
  assert.deepEqual(run(literalTypeMismatch, src), []);
});
