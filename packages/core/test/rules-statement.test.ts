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
  enumValueNotDefined,
  insertMissingRequiredColumn,
  insertUnknownColumn,
  insertSelectColumnCount,
  insertValueCount,
  joinMultipliesAggregate,
  joinWithoutCondition,
  aggregateWithoutGroupBy,
  leftJoinArithmetic,
  literalTypeMismatch,
  nullableScalarSubquery,
  onlyFullGroupBy,
  outArgumentNotVariable,
  scalarSubqueryManyRows,
  selectIntoArity,
  selectIntoManyRows,
  unfilteredWrite,
  unknownAlias,
  unknownColumn,
  unknownRoutine,
  unknownTable,
  unqualifiedColumn,
  writeTargetInSubquery,
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
  // One column of every kind the required-column rule has to stand down for: a key the engine
  // fills, a written default, a nullable, and a timestamp whose default may be implicit.
  "CREATE TABLE payments (",
  "  payment_id int NOT NULL AUTO_INCREMENT,",
  "  order_id int NOT NULL,",
  "  method varchar(10) NOT NULL DEFAULT 'card',",
  "  note varchar(80) NULL,",
  "  received_at timestamp NOT NULL,",
  "  fee decimal(10,2) NOT NULL,",
  "  PRIMARY KEY (payment_id)",
  ");",
  // An enum-like column with its codes written down — the only source the enum rule will use — and
  // one beside it whose comment is prose, so there is something for it to stand down for.
  "CREATE TABLE tickets (",
  "  ticket_id int NOT NULL,",
  "  state char(1) NOT NULL COMMENT 'O: open, C: closed, X: cancelled',",
  "  channel char(1) NOT NULL COMMENT 'Where the ticket came from, one letter',",
  "  PRIMARY KEY (ticket_id)",
  ");",
  // The audit twin of `orders`, three columns wider: what a positional `INSERT … SELECT` is counted
  // against, and where a star has to be expanded to count anything at all.
  "CREATE TABLE aud_orders (",
  "  aud_id int NOT NULL AUTO_INCREMENT,",
  "  changed_at datetime NOT NULL,",
  "  changed_by varchar(20) NOT NULL,",
  "  order_id int NOT NULL,",
  "  customer_id int NOT NULL,",
  "  status char(1) NOT NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  PRIMARY KEY (aud_id)",
  ");",
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

test("with two triggers in the file, each one's NEW is its own table's", () => {
  // A statement is resolved against the body it is in. Read against the file, `NEW` is whichever
  // trigger comes last, so the first one's columns get checked against the second one's table —
  // which is worse than an unknown name, because it is a confident answer about the wrong table.
  const src = [
    "CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW BEGIN",
    "  SET @x = NEW.total;",
    "END;",
    "CREATE TRIGGER customers_bi BEFORE INSERT ON customers FOR EACH ROW BEGIN",
    "  SET @y = NEW.label;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(unknownColumn, src), []);
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

test("a column list that leaves out a required column is an error", () => {
  assert.deepEqual(run(insertMissingRequiredColumn, "INSERT INTO payments (order_id) VALUES (1);"), [
    "payments needs a value for fee",
  ]);
});

test("a column the engine can fill on its own is not required", () => {
  // Every one of the four is left out here: the auto-increment key, the written default, the
  // nullable, and the timestamp. Naming the two that are actually required is enough.
  const src = "INSERT INTO payments (order_id, fee) VALUES (1, 2.00);";
  assert.deepEqual(run(insertMissingRequiredColumn, src), []);
});

test("a generated column is not required either", () => {
  assert.deepEqual(run(insertMissingRequiredColumn, "INSERT INTO events (event_id, payload) VALUES (1, 'x');"), []);
  assert.deepEqual(run(insertMissingRequiredColumn, "INSERT INTO events (event_id) VALUES (1);"), [
    "events needs a value for payload",
  ]);
});

test("without a column list this rule says nothing, because the count is the question", () => {
  assert.deepEqual(run(insertMissingRequiredColumn, "INSERT INTO payments VALUES (1, 2);"), []);
});

test("INSERT ... SET is a third syntax and is not read as a column list", () => {
  assert.deepEqual(run(insertMissingRequiredColumn, "INSERT INTO payments SET order_id = 1;"), []);
});

test("where the values come from does not matter, only the list", () => {
  const src = "INSERT INTO payments (order_id) SELECT order_id FROM orders;";
  assert.deepEqual(run(insertMissingRequiredColumn, src), ["payments needs a value for fee"]);
});

test("an empty parenthesis names nothing, so nothing is missing from it", () => {
  // `INSERT INTO t () SELECT …` is a positional insert with an empty pair of brackets in front.
  const empty = "INSERT INTO payments () SELECT * FROM payments;";
  assert.deepEqual(run(insertMissingRequiredColumn, empty), []);
  // The pair: a list that does name something is still read.
  const named = "INSERT INTO payments (order_id) SELECT order_id FROM orders;";
  assert.deepEqual(run(insertMissingRequiredColumn, named), ["payments needs a value for fee"]);
});

test("a list naming a column the table does not have is left to the rule that says so", () => {
  const wrong = "INSERT INTO payments (order_id, nope) VALUES (1, 2);";
  assert.deepEqual(run(insertMissingRequiredColumn, wrong), []);
  assert.deepEqual(run(insertUnknownColumn, wrong), ["payments has no column nope"]);
});

// ------------------------------------------- INSERT … SELECT: filling the table

test("an INSERT … SELECT short of the table it writes to is reported", () => {
  // The audit shape, one scalar short: the star is four columns, so this hands over six of seven.
  const src = "INSERT INTO aud_orders SELECT 0, NOW(), o.* FROM orders o;";
  assert.deepEqual(run(insertSelectColumnCount, src), [
    "this SELECT gives aud_orders 6 column(s) and it expects 7",
  ]);
});

test("and the same shape that does add up says nothing", () => {
  const src = "INSERT INTO aud_orders SELECT 0, NOW(), 'me', o.* FROM orders o;";
  assert.deepEqual(run(insertSelectColumnCount, src), []);
});

test("the star is counted from the catalog, which is the only place its width lives", () => {
  // `SELECT *` over a join is every column of both, in order — four and two here.
  const joined = "INSERT INTO aud_orders SELECT * FROM orders o JOIN customers c USING (customer_id);";
  assert.deepEqual(run(insertSelectColumnCount, joined), [
    "this SELECT gives aud_orders 6 column(s) and it expects 7",
  ]);
});

test("a star it cannot expand is a width it does not have, so nothing is claimed", () => {
  // A temporary table's columns are not knowable from here, and this rule reports errors.
  const temp = "INSERT INTO aud_orders SELECT 0, NOW(), t.* FROM tmp_from_other_sp t;";
  const derived = "INSERT INTO aud_orders SELECT x.* FROM (SELECT 1 AS n) x;";
  assert.deepEqual(run(insertSelectColumnCount, temp), []);
  assert.deepEqual(run(insertSelectColumnCount, derived), []);
});

test("with a column list the count is against the list, not the table", () => {
  const src = "INSERT INTO aud_orders (aud_id, changed_at) SELECT 0, NOW(), 'me' FROM orders;";
  assert.deepEqual(run(insertSelectColumnCount, src), [
    "this SELECT gives aud_orders 3 column(s) and it expects 2",
  ]);
});

test("an empty column list is named as such, rather than left as a count of zero", () => {
  // `INSERT INTO t () SELECT …` is legal to write and cannot run. "expects 0" would leave the reader
  // counting the table's columns to work out why.
  const src = "INSERT INTO aud_orders () SELECT 0, NOW(), 'me', o.* FROM orders o;";
  assert.deepEqual(run(insertSelectColumnCount, src), [
    "aud_orders () is an empty column list, and this SELECT hands it 7 column(s)",
  ]);
});

test("a generated column may be passed or left out, so both counts are accepted", () => {
  const withIt = "INSERT INTO events SELECT 1, 'p', DEFAULT;";
  const without = "INSERT INTO events SELECT 1, 'p';";
  assert.deepEqual(run(insertSelectColumnCount, withIt), []);
  assert.deepEqual(run(insertSelectColumnCount, without), []);
});

test("a UNION is two lists the engine has already compared with each other", () => {
  const src = "INSERT INTO aud_orders SELECT 0, NOW() UNION SELECT 1, NOW();";
  assert.deepEqual(run(insertSelectColumnCount, src), []);
});

test("the VALUES form is the other rule's, and a table nothing defines is nobody's", () => {
  assert.deepEqual(run(insertSelectColumnCount, "INSERT INTO aud_orders VALUES (1, 2);"), []);
  assert.deepEqual(run(insertSelectColumnCount, "INSERT INTO nowhere SELECT 1, 2;"), []);
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

test("RETURNING is a JSON_VALUE clause, not a column of the table being read", () => {
  // Written bare inside the call, it reads exactly like a column name nothing declares — which is
  // what every typed read of a JSON argument in a routine was being reported as.
  const src = "SELECT order_id FROM orders WHERE order_id = JSON_VALUE(@doc, '$.order.id' RETURNING UNSIGNED);";
  assert.deepEqual(run(unqualifiedColumn, src), []);
});

test("a parameter of the routine the statement is in is not a column", () => {
  assert.deepEqual(run(unqualifiedColumn, body("  SELECT order_id FROM orders WHERE order_id = p_id;")), []);
});

test("and it is that routine's parameter, not the last routine's in the file", () => {
  // Every routine but the last used to lose its parameters, because the locals were collected for
  // the file at once and `collect` reads the routine at an offset as the last one before it. In a
  // `sp/` repo of one procedure per file nothing showed; a file holding two reported each of the
  // first one's parameters as a column nothing declares.
  const src = [
    "CREATE PROCEDURE sp_first(IN p_first int)",
    "BEGIN",
    "  SELECT order_id FROM orders WHERE order_id = p_first;",
    "END;",
    "CREATE PROCEDURE sp_second(IN p_second int)",
    "BEGIN",
    "  SELECT order_id FROM orders WHERE order_id = p_second;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(unqualifiedColumn, src), []);
});

test("a statement outside every body still has the file's locals", () => {
  // A `carga-valores/` file is statements and no routine at all, and the temporary table it reads
  // may be created further down: the file-wide view is the right one where there is no body.
  const src = ["SELECT * FROM tmp_here;", "CREATE TEMPORARY TABLE tmp_here (id int);"].join("\n");
  assert.deepEqual(run(unqualifiedColumn, src), []);
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

// ------------------------------------------- the written table, read again

const REJECTED = "MySQL rejects the statement with error 1093";

test("an UPDATE whose subquery reads the table it writes never runs", () => {
  const src = "UPDATE orders SET status = 'A' WHERE order_id IN (SELECT order_id FROM orders WHERE status = 'B');";
  assert.deepEqual(run(writeTargetInSubquery, src), [`this UPDATE writes orders, and this subquery reads it: ${REJECTED}`]);
});

test("the same read behind a derived table is how it is written instead", () => {
  const src =
    "UPDATE orders SET status = 'A' WHERE order_id IN (SELECT id FROM (SELECT order_id AS id FROM orders WHERE status = 'B') x);";
  assert.deepEqual(run(writeTargetInSubquery, src), [], "MySQL evaluates that one on its own");
});

test("a DELETE is refused on the same terms, and a read of another table is not", () => {
  assert.deepEqual(run(writeTargetInSubquery, "DELETE FROM orders WHERE order_id = (SELECT MAX(order_id) FROM orders);"), [
    `this DELETE writes orders, and this subquery reads it: ${REJECTED}`,
  ]);
  assert.deepEqual(
    run(writeTargetInSubquery, "DELETE FROM orders WHERE order_id IN (SELECT order_id FROM refunds WHERE amount > 0);"),
    [],
  );
});

test("a join inside the subquery reaches the target just as a FROM does", () => {
  const src =
    "UPDATE orders SET status = 'A' WHERE EXISTS (SELECT 1 FROM customers c JOIN orders o2 ON o2.customer_id = c.customer_id);";
  assert.deepEqual(run(writeTargetInSubquery, src), [`this UPDATE writes orders, and this subquery reads it: ${REJECTED}`]);
});

test("a multi-table UPDATE writes what its SET assigns to, and no more", () => {
  const joined =
    "UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id SET o.status = 'A' " +
    "WHERE EXISTS (SELECT 1 FROM customers c2 WHERE c2.customer_id = o.customer_id);";
  assert.deepEqual(run(writeTargetInSubquery, joined), [], "customers is read by the write, not written by it");

  const target =
    "UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id SET o.status = 'A' " +
    "WHERE NOT EXISTS (SELECT 1 FROM orders o2 WHERE o2.customer_id = o.customer_id AND o2.status = 'A');";
  assert.deepEqual(run(writeTargetInSubquery, target), [
    `this UPDATE writes orders, and this subquery reads it: ${REJECTED}`,
  ]);
});

test("a bare column in a joined UPDATE's SET does not say which table is written", () => {
  const src =
    "UPDATE orders o JOIN customers c ON c.customer_id = o.customer_id SET status = 'A' " +
    "WHERE EXISTS (SELECT 1 FROM orders o2);";
  assert.deepEqual(run(writeTargetInSubquery, src), [], "the engine rejects this one, and the statement does not say why");
});

test("a multi-table DELETE names its targets before the FROM", () => {
  const target =
    "DELETE o FROM orders o JOIN customers c ON c.customer_id = o.customer_id " +
    "WHERE EXISTS (SELECT 1 FROM orders o2 WHERE o2.status = 'A');";
  assert.deepEqual(run(writeTargetInSubquery, target), [
    `this DELETE writes orders, and this subquery reads it: ${REJECTED}`,
  ]);

  const joined =
    "DELETE o FROM orders o JOIN customers c ON c.customer_id = o.customer_id " +
    "WHERE EXISTS (SELECT 1 FROM customers c2 WHERE c2.customer_id = o.customer_id);";
  assert.deepEqual(run(writeTargetInSubquery, joined), [], "customers is joined, not deleted from");
});

test("a common table expression is a query of its own, and so is a self-join", () => {
  const cte =
    "WITH recent AS (SELECT order_id FROM orders WHERE status = 'B') " +
    "UPDATE orders SET status = 'A' WHERE order_id IN (SELECT order_id FROM recent);";
  assert.deepEqual(run(writeTargetInSubquery, cte), []);

  const selfJoin =
    "UPDATE orders o LEFT JOIN orders open ON open.customer_id = o.customer_id AND open.status = 'A' " +
    "SET o.status = 'A' WHERE open.order_id IS NULL;";
  assert.deepEqual(run(writeTargetInSubquery, selfJoin), [], "reading it in the write's own FROM is allowed");
});

test("a correlated reference to the row being written names no relation", () => {
  const src =
    "UPDATE orders SET total = (SELECT SUM(l.amount) FROM order_lines l WHERE l.order_id = orders.order_id);";
  assert.deepEqual(run(writeTargetInSubquery, src), [], "the target is a qualifier there, not a table of the subquery");
});

test("an INSERT reading its own target is a different question", () => {
  const src = "INSERT INTO orders (customer_id, status) SELECT customer_id, 'B' FROM orders WHERE status = 'A';";
  assert.deepEqual(run(writeTargetInSubquery, src), [], "MySQL allows this one");
});

test("one side qualified and the other not is not known to be the same table", () => {
  const src = "UPDATE orders SET status = 'A' WHERE order_id IN (SELECT order_id FROM archive.orders);";
  assert.deepEqual(run(writeTargetInSubquery, src), []);
});

test("a temporary table is the same defect under another number", () => {
  const src = "UPDATE tmp_from_other_sp SET total = 0 WHERE batch_id IN (SELECT batch_id FROM tmp_from_other_sp);";
  assert.deepEqual(run(writeTargetInSubquery, src), [
    "this UPDATE writes tmp_from_other_sp, and this subquery reads it: " +
      "MySQL cannot open a temporary table twice in one statement (error 1137)",
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

test("an aggregate that is both multiplied by a join and NULL over nothing gets both findings", () => {
  // These are two defects with two fixes — the number is multiplied *and* it can be NULL — so
  // neither rule declares that it displaces the other and the reader hears both. The engine used to
  // keep whichever was registered first, which silently answered a question nobody had asked.
  const src = body("  SET p_id = (SELECT SUM(o.total) FROM orders o JOIN refunds r USING(order_id)) + 1;");
  const found = check(
    new Registry().add(joinMultipliesAggregate, nullableScalarSubquery),
    { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
    src,
  );
  assert.deepEqual(
    found.map((d) => d.code).sort(),
    ["query/join-multiplies-aggregate", "query/nullable-scalar-subquery"],
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

test("IN over a subquery that yields one value finishes the key, and over one that may not does not", () => {
  // The last line of an order, written the way it usually is. The inner `MAX` has no `GROUP BY`, so
  // it is one value, `line_no` is pinned, and `(order_id, line_no)` is covered whole.
  const latest =
    "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 " +
    "AND l.line_no IN (SELECT MAX(line_no) FROM order_lines WHERE order_id = 7));";
  assert.deepEqual(run(scalarSubqueryManyRows, latest), []);

  // `LIMIT 1` is the other way of yielding exactly one.
  const limited =
    "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 " +
    "AND l.line_no IN (SELECT line_no FROM order_lines WHERE order_id = 7 LIMIT 1));";
  assert.deepEqual(run(scalarSubqueryManyRows, limited), []);

  // A `GROUP BY` hands the aggregate back once per group, so the `IN` is free to match several lines.
  const grouped =
    "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 " +
    "AND l.line_no IN (SELECT MAX(line_no) FROM order_lines GROUP BY order_id));";
  assert.equal(run(scalarSubqueryManyRows, grouped).length, 1);

  // No aggregate and no limit: an ordinary many-row subquery, which is what `IN` is normally for.
  const many =
    "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 " +
    "AND l.line_no IN (SELECT line_no FROM order_lines WHERE order_id = 7));";
  assert.equal(run(scalarSubqueryManyRows, many).length, 1);

  // A list of literals says the author expects more than one.
  const list = "SELECT 1 + (SELECT l.amount FROM order_lines l WHERE l.order_id = 7 AND l.line_no IN (1, 2));";
  assert.equal(run(scalarSubqueryManyRows, list).length, 1);
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

// ------------------------------------------ a SELECT … INTO of the wrong width

test("a SELECT … INTO that reads more columns than it fills is reported", () => {
  const src = body("  SELECT o.order_id, o.customer_id, o.status INTO p_id, p_id FROM orders o;");
  assert.deepEqual(run(selectIntoArity, src), [
    "this SELECT reads 3 column(s) into 2 variable(s): MySQL answers error 1222 rather than filling them",
  ]);
});

test("both spellings are read, because these schemas contain both", () => {
  const trailing = body("  SELECT o.order_id, o.customer_id FROM orders o INTO p_id;");
  assert.deepEqual(run(selectIntoArity, trailing), [
    "this SELECT reads 2 column(s) into 1 variable(s): MySQL answers error 1222 rather than filling them",
  ]);
  const balanced = body("  SELECT o.order_id, o.customer_id FROM orders o INTO p_id, p_id;");
  assert.deepEqual(run(selectIntoArity, balanced), []);
});

test("a star is counted from the catalog, and one it cannot expand is not counted at all", () => {
  const star = body("  SELECT o.* INTO p_id, p_id FROM orders o;");
  assert.deepEqual(run(selectIntoArity, star), [
    "this SELECT reads 4 column(s) into 2 variable(s): MySQL answers error 1222 rather than filling them",
  ]);
  const temp = body("  SELECT t.* INTO p_id, p_id FROM tmp_from_other_sp t;");
  assert.deepEqual(run(selectIntoArity, temp), []);
});

test("a star inside a call is not a select list of its own", () => {
  // `COUNT(*)` is one value. Reading its star as the table's columns would make every counted
  // aggregate a mismatch.
  assert.deepEqual(run(selectIntoArity, body("  SELECT COUNT(*) INTO p_id FROM orders;")), []);
});

test("OUTFILE names a file rather than variables, and a UNION is two lists", () => {
  const outfile = body("  SELECT o.order_id, o.status INTO OUTFILE '/tmp/x' FROM orders o;");
  const union = body("  SELECT 1, 2 UNION SELECT 3, 4 INTO p_id;");
  assert.deepEqual(run(selectIntoArity, outfile), []);
  assert.deepEqual(run(selectIntoArity, union), []);
});

test("a statement that cannot run is not also reported for how many rows it would return", () => {
  // Both rules see this line. The arity one displaces the other: error 1222 comes first, and
  // "it might match twice" is advice about a statement that never gets that far.
  const src = body("  SELECT l.order_id, l.amount INTO p_id FROM order_lines l WHERE l.order_id = 7;");
  assert.deepEqual(
    check(
      new Registry().add(selectIntoArity, selectIntoManyRows),
      { dialect: mysql, catalog: catalogOf(), schemas: new Set(["shop"]), config: defaults },
      src,
    ).map((d) => d.code),
    ["routine/select-into-arity"],
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

test("a query with no grouping at all belongs to the other rule", () => {
  // `query/aggregate-without-group-by` answers that one, and needs neither the keys nor the closure
  // this one is built on. Splitting them is what lets the cheap answer be trusted on its own.
  assert.deepEqual(run(onlyFullGroupBy, "SELECT o.status, COUNT(*) FROM orders o;"), []);
  assert.equal(run(aggregateWithoutGroupBy, "SELECT o.status, COUNT(*) FROM orders o;").length, 1);

  // And an ordinary select is neither rule's business.
  assert.deepEqual(run(aggregateWithoutGroupBy, "SELECT o.status, o.total FROM orders o;"), []);
});

test("what the aggregate rule leaves alone", () => {
  const cases = [
    "SELECT COUNT(*) FROM orders o;",
    "SELECT SUM(o.total) AS total FROM orders o;",
    "SELECT *, COUNT(*) FROM orders o;",
    "SELECT o.status, COUNT(*) FROM orders o GROUP BY o.status;",
  ];
  for (const src of cases) assert.deepEqual(run(aggregateWithoutGroupBy, src), [], src);
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

// ------------------------------------------- a code the column does not declare

test("a comparison against a code the COMMENT does not list is reported", () => {
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state = 'Z';"), [
    "t.state declares (O, C, X) and this compares it with 'Z': no row can hold that",
  ]);
});

test("a code it does list is not, and case is ignored because the server ignores it", () => {
  // Under the `_ci` collations these columns carry, `= 'o'` finds the rows holding `'O'`.
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state = 'O';"), []);
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state = 'o';"), []);
});

test("the same mistake read from the other end passes every row instead of none", () => {
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state != 'Z';"), [
    "t.state declares (O, C, X) and this compares it with 'Z': every row passes this",
  ]);
});

test("an IN list names every code that cannot be there, and says nothing when they all can", () => {
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state IN ('O', 'Z', 'Q');"), [
    "t.state declares (O, C, X) and this looks for 'Z', 'Q': no row can hold that",
  ]);
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state IN ('O', 'C');"), []);
});

test("a bare name resolves the same way, when one relation owns it", () => {
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets WHERE state = 'Z';"), [
    "state declares (O, C, X) and this compares it with 'Z': no row can hold that",
  ]);
});

test("a comment that is prose declares no set, and neither does no comment at all", () => {
  // `channel` has a comment; it is a sentence, not a list. `orders.status` has none. Silence is not
  // evidence that a code is legal — it is nobody having written the set down.
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.channel = 'Z';"), []);
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM orders o WHERE o.status = 'Z';"), []);
});

test("the empty string is a real question about real rows", () => {
  // `char(1) NOT NULL DEFAULT ''` is ordinary, and no comment lists the absence of a code.
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state = '';"), []);
});

test("a number is the type rule's finding, and a SET is a different claim", () => {
  assert.deepEqual(run(enumValueNotDefined, "SELECT * FROM tickets t WHERE t.state = 9;"), []);
  assert.deepEqual(run(enumValueNotDefined, "UPDATE tickets SET state = 'Z' WHERE ticket_id = 1;"), []);
});

test("a WHERE beside an assignment is still a comparison", () => {
  // The `SET` is skipped, not the whole statement: an UPDATE's `WHERE` is where this bites hardest,
  // because a condition that matches nothing makes the write silently do nothing.
  assert.deepEqual(run(enumValueNotDefined, "UPDATE tickets SET channel = 'A' WHERE state = 'Z';"), [
    "state declares (O, C, X) and this compares it with 'Z': no row can hold that",
  ]);
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
