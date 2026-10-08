/**
 * Finding a name's uses, over sources written out in the test.
 *
 * The whole module is a question about text, so a fixture directory would only put a filesystem
 * between the case and what it is about. Where the hits *go* — URIs, ranges, an edit — is the
 * language server's problem and is checked there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CatalogLookup } from "../src/catalog/catalog.ts";
import { find, scan, type FileSource, type RefTarget } from "../src/analysis/references.ts";
import type { ResolveContext } from "../src/analysis/resolve.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Table } from "../src/model/table.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

/**
 * The schema every case resolves against. `customer_id` is on two tables on purpose: it is the
 * name whose uses have to be told apart.
 */
const SCHEMA = [
  "CREATE TABLE orders (",
  "  order_id int NOT NULL,",
  "  customer_id int NOT NULL,",
  "  total decimal(10,2) NOT NULL,",
  "  status char(1) NOT NULL,",
  "  PRIMARY KEY (order_id)",
  ");",
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  label varchar(40) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
  "CREATE TABLE shipments (",
  "  shipment_id int NOT NULL,",
  "  order_id int NOT NULL,",
  "  PRIMARY KEY (shipment_id)",
  ");",
].join("\n");

function catalogOf(schema: string): CatalogLookup {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, schema, tokenize(schema)).tables) {
    if (!table.temporary) tables.set(table.name.toLowerCase(), table);
  }
  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: () => undefined,
  };
}

const CTX: ResolveContext = { dialect: mysql, catalog: catalogOf(SCHEMA), schemas: new Set() };

/** The hits as the substrings they cover, which is what the assertions read best. */
function hits(src: string, target: RefTarget): string[] {
  return find(CTX, src, target).map((ref) => src.slice(ref.s, ref.e));
}

/** The hits as written, qualifier included, which is what tells `o.customer_id` from its neighbour. */
function uses(src: string, target: RefTarget): string[] {
  return find(CTX, src, target).map((ref) => {
    const before = /[\w`]*\.?$/.exec(src.slice(0, ref.s))![0];
    return before + src.slice(ref.s, ref.e);
  });
}

/** Where the hits start, for the cases that are about *which* of two identical spellings was kept. */
function offsets(src: string, target: RefTarget): number[] {
  return find(CTX, src, target).map((ref) => ref.s);
}

const ON_ORDERS_ID: RefTarget = { name: "customer_id", owner: "orders", ownerHasColumn: true };
const ON_CUSTOMERS_ID: RefTarget = { name: "customer_id", owner: "customers", ownerHasColumn: true };

function sources(...list: [string, string][]): FileSource[] {
  return list.map(([path, src]) => ({ path, src }));
}

// -------------------------------------------------------- whole identifiers

test("a name is found wherever it is written", () => {
  assert.deepEqual(hits("SELECT 1 FROM orders; UPDATE orders SET total = 1;", { name: "orders" }), [
    "orders",
    "orders",
  ]);
});

test("a longer name that contains it is a different name", () => {
  // The whole point of lexing rather than searching: an audit twin and a log table are their own
  // tables, and on a central name they outnumber the real hits.
  assert.deepEqual(hits("SELECT 1 FROM orders, aud_orders, LogOrders;", { name: "orders" }), ["orders"]);
});

test("what is inside a string is not a use", () => {
  assert.deepEqual(hits("SELECT 'orders' FROM orders;", { name: "orders" }), ["orders"]);
});

test("what is inside a comment is not a use", () => {
  assert.deepEqual(hits("-- drop orders\nSELECT 1 FROM orders;", { name: "orders" }), ["orders"]);
  assert.deepEqual(hits("/* orders */ SELECT 1 FROM orders;", { name: "orders" }), ["orders"]);
});

test("case is not part of the name, as everywhere else in the catalog", () => {
  assert.deepEqual(hits("SELECT 1 FROM orders, ORDERS;", { name: "Orders" }), ["orders", "ORDERS"]);
});

test("a delimited use is covered along with its backticks", () => {
  // The lexer strips them, but a rename has to replace the whole thing or the result is `` `x`x ``.
  assert.deepEqual(hits("SELECT 1 FROM `orders`;", { name: "orders" }), ["`orders`"]);
});

test("each hit says whether it was written qualified", () => {
  const found = find(CTX, "SELECT o.status, status FROM orders o;", { name: "status" });
  assert.equal(found.length, 2);
  assert.equal(found[0]!.qualified, true);
  assert.equal(found[1]!.qualified, false);
});

test("each hit says whether it was written delimited", () => {
  const found = find(CTX, "SELECT `status`, status FROM orders;", { name: "status" });
  assert.deepEqual(
    found.map((ref) => ref.quoted),
    [true, false],
  );
});

// ------------------------------------------------ a column scoped to its table

const ON_ORDERS: RefTarget = { name: "status", owner: "orders", ownerHasColumn: true };

test("a use qualified by the table's alias is kept", () => {
  assert.deepEqual(hits("SELECT o.status FROM orders o;", ON_ORDERS), ["status"]);
});

test("a use qualified by the table's own name is kept", () => {
  assert.deepEqual(hits("SELECT orders.status FROM orders;", ON_ORDERS), ["status"]);
});

test("a use qualified by another table is dropped", () => {
  assert.deepEqual(hits("SELECT c.status FROM orders o JOIN customers c ON 1;", ON_ORDERS), []);
});

test("a bare use is kept when the statement involves the table", () => {
  assert.deepEqual(hits("SELECT status FROM orders;", ON_ORDERS), ["status"]);
});

test("a bare use in a statement that never names the table is dropped", () => {
  assert.deepEqual(hits("SELECT status FROM customers;", ON_ORDERS), []);
});

test("a bare use is dropped when the table has no such column", () => {
  // Not belt and braces. Without this check, asking about a column its table does not have
  // returns every bare `status` of every other table joined alongside it — a wrong answer rather
  // than a broad one.
  assert.deepEqual(
    hits("SELECT status FROM orders o JOIN customers c ON 1;", {
      name: "status",
      owner: "orders",
      ownerHasColumn: false,
    }),
    [],
  );
});

test("a qualified use is kept even when the catalog says the column is not there", () => {
  // Somebody writing `o.status` means that column whether or not it exists, and being shown where
  // they wrote it is the point when the answer is "nowhere, it is called state".
  assert.deepEqual(
    hits("SELECT o.status FROM orders o;", { name: "status", owner: "orders", ownerHasColumn: false }),
    ["status"],
  );
});

test("a column's own CREATE TABLE is reached by an owner-scoped search", () => {
  // The declaration is the one place the column is defined rather than used, and a rename that
  // skipped it would leave the schema disagreeing with the queries it just rewrote.
  assert.deepEqual(hits("CREATE TABLE `orders` (`status` char(1) NOT NULL);", ON_ORDERS), ["`status`"]);
});

test("the same CREATE TABLE of another table is not", () => {
  assert.deepEqual(hits("CREATE TABLE `customers` (`status` char(1) NOT NULL);", ON_ORDERS), []);
});

// ----------------------------------------------- whose column a bare name is

test("a join keeps its own table's column and drops the other table's", () => {
  const src = "SELECT o.customer_id, c.customer_id FROM orders o JOIN customers c ON c.customer_id = o.customer_id;";
  assert.deepEqual(uses(src, ON_ORDERS_ID), ["o.customer_id", "o.customer_id"]);
  assert.deepEqual(uses(src, ON_CUSTOMERS_ID), ["c.customer_id", "c.customer_id"]);
});

test("a USING column is both tables' at once", () => {
  const src = "SELECT customer_id FROM orders JOIN customers USING (customer_id);";
  assert.equal(find(CTX, src, ON_ORDERS_ID).length, 2);
  assert.equal(find(CTX, src, ON_CUSTOMERS_ID).length, 2);
  // And a query over some other table is neither's.
  assert.deepEqual(hits("SELECT customer_id FROM customers;", ON_ORDERS_ID), []);
});

test("a correlated subquery's bare name is the inner table's", () => {
  const src = "SELECT o.order_id FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE customer_id = o.customer_id);";
  assert.deepEqual(uses(src, ON_ORDERS_ID), ["o.customer_id"]);
  assert.deepEqual(uses(src, ON_CUSTOMERS_ID), ["customer_id"]);
});

test("a subquery whose table lacks the name leaves it to the query around it", () => {
  const src = "SELECT o.order_id FROM orders o WHERE EXISTS (SELECT 1 FROM shipments s WHERE customer_id = 1);";
  assert.deepEqual(uses(src, ON_ORDERS_ID), ["customer_id"]);
  assert.deepEqual(uses(src, ON_CUSTOMERS_ID), []);
});

test("a query beside an IF EXISTS over another table is not joined to it", () => {
  const src = [
    "CREATE PROCEDURE sp_settle_orders()",
    "BEGIN",
    "  IF EXISTS (SELECT 1 FROM orders) THEN",
    "    UPDATE customers SET label = 'x' WHERE customer_id = 2;",
    "  END IF;",
    "END;",
  ].join("\n");
  assert.deepEqual(hits(src, ON_ORDERS_ID), []);
  assert.deepEqual(hits(src, ON_CUSTOMERS_ID), ["customer_id"]);
});

test("the list of an INSERT is the target's and its SELECT is the source's", () => {
  const src = "INSERT INTO orders (customer_id, total) SELECT customer_id, 1 FROM customers;";
  const select = src.indexOf("SELECT");
  assert.deepEqual(
    offsets(src, ON_ORDERS_ID).map((at) => at < select),
    [true],
  );
  assert.deepEqual(
    offsets(src, ON_CUSTOMERS_ID).map((at) => at > select),
    [true],
  );
});

test("a local of the same name is not the column, and the next routine's use still is", () => {
  const src = [
    "CREATE PROCEDURE sp_first()",
    "BEGIN",
    "  DECLARE customer_id int DEFAULT 0;",
    "  SELECT customer_id FROM orders;",
    "END;",
    "CREATE PROCEDURE sp_second()",
    "BEGIN",
    "  SELECT customer_id FROM orders;",
    "END;",
  ].join("\n");
  assert.deepEqual(offsets(src, ON_ORDERS_ID), [src.lastIndexOf("customer_id")]);
});

test("a name the select list gave to something else is not the column in ORDER BY", () => {
  assert.deepEqual(hits("SELECT total AS customer_id FROM orders ORDER BY customer_id;", ON_ORDERS_ID), []);
  // The same ORDER BY over the column itself is a use of it, as is the list that named it.
  assert.deepEqual(hits("SELECT customer_id FROM orders ORDER BY customer_id;", ON_ORDERS_ID), [
    "customer_id",
    "customer_id",
  ]);
});

test("a WITH name or a temporary table called like the owner is not the owner", () => {
  assert.deepEqual(
    hits("WITH orders AS (SELECT 1 AS customer_id) SELECT orders.customer_id FROM orders;", ON_ORDERS_ID),
    [],
  );
  assert.deepEqual(
    hits(
      "CREATE TEMPORARY TABLE orders (customer_id int); SELECT orders.customer_id FROM orders;",
      ON_ORDERS_ID,
    ),
    [],
  );
  // Without the shadowing, the same text is the table's.
  assert.deepEqual(hits("SELECT orders.customer_id FROM orders;", ON_ORDERS_ID), ["customer_id"]);
});

test("NEW and OLD are the columns of the table the trigger is on", () => {
  const on = (table: string): string =>
    [
      `CREATE TRIGGER trg_${table}_bu BEFORE UPDATE ON ${table} FOR EACH ROW`,
      "BEGIN",
      "  IF NEW.customer_id <> OLD.customer_id THEN SET NEW.customer_id = OLD.customer_id; END IF;",
      "END;",
    ].join("\n");
  assert.deepEqual(uses(on("orders"), ON_ORDERS_ID), ["NEW.customer_id", "OLD.customer_id", "NEW.customer_id", "OLD.customer_id"]);
  assert.deepEqual(uses(on("customers"), ON_ORDERS_ID), []);
  assert.equal(find(CTX, on("customers"), ON_CUSTOMERS_ID).length, 4);
});

test("a qualified use does not need its table in the FROM", () => {
  assert.deepEqual(hits("SELECT orders.total FROM customers;", { name: "total", owner: "orders", ownerHasColumn: true }), [
    "total",
  ]);
  assert.deepEqual(hits("SELECT customers.total FROM customers;", { name: "total", owner: "orders", ownerHasColumn: true }), []);
});

// ----------------------------------------------------------------------- DDL

test("a column is found in its declaration, its keys and its checks, and not in the table it references", () => {
  const src = [
    "CREATE TABLE orders (",
    "  order_id int NOT NULL,",
    "  customer_id int NOT NULL,",
    "  total decimal(10,2) NOT NULL,",
    "  double_id int AS (customer_id * 2),",
    "  PRIMARY KEY (order_id),",
    "  KEY ix_customer (customer_id),",
    "  CHECK (customer_id > 0),",
    "  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (customer_id)",
    ");",
  ].join("\n");
  const references = src.indexOf("REFERENCES");
  const own = offsets(src, ON_ORDERS_ID);
  // Declaration, generated column, key, check and the foreign key's own side.
  assert.equal(own.length, 5);
  assert.ok(own.every((at) => at < references));
  // The one after `REFERENCES customers` is the other table's, and nothing else is.
  const other = offsets(src, ON_CUSTOMERS_ID);
  assert.equal(other.length, 1);
  assert.ok(other[0]! > references);
});

test("the name of a constraint or an index is not a column", () => {
  const src = "CREATE TABLE orders (customer_id int, KEY customer_id_ix (customer_id), CONSTRAINT customer_id FOREIGN KEY (customer_id) REFERENCES customers (customer_id));";
  assert.equal(find(CTX, src, ON_ORDERS_ID).length, 3);
});

test("an ALTER TABLE belongs to the table it alters", () => {
  const src = "ALTER TABLE orders ADD KEY ix_customer (customer_id), CHANGE customer_id customer_ref int;";
  assert.equal(find(CTX, src, ON_ORDERS_ID).length, 2);
  assert.deepEqual(hits("ALTER TABLE customers DROP COLUMN customer_id;", ON_ORDERS_ID), []);
});

test("a CREATE INDEX belongs to the table it is on", () => {
  assert.deepEqual(hits("CREATE INDEX ix_customer ON orders (customer_id);", ON_ORDERS_ID), ["customer_id"]);
  assert.deepEqual(hits("CREATE UNIQUE INDEX ix_customer ON customers (customer_id);", ON_ORDERS_ID), []);
});

test("a temporary table's declaration is not a catalog table's", () => {
  assert.deepEqual(hits("CREATE TEMPORARY TABLE orders (customer_id int);", ON_ORDERS_ID), []);
});

test("the query after a CREATE TABLE is read as a query", () => {
  const src = "CREATE TABLE copy_of_orders (customer_id int) SELECT customer_id FROM orders;";
  // The column list is `copy_of_orders`' own, which the catalog does not hold; the SELECT's is orders'.
  assert.deepEqual(offsets(src, ON_ORDERS_ID), [src.lastIndexOf("customer_id FROM")]);
});

// ------------------------------------------------------------- over a project

test("a file that never mentions the name is never lexed", () => {
  const found = scan(CTX, sources(["/a.sql", "SELECT 1 FROM orders;"], ["/b.sql", "SELECT 1 FROM customers;"]), {
    name: "orders",
  });
  assert.deepEqual(
    found.map((file) => file.path),
    ["/a.sql"],
  );
});

test("a column's file has to name its table too", () => {
  // The second cheap gate in front of the lexer: a file using a column has to name its table
  // somewhere, so both substring tests are applied before anything is parsed.
  const found = scan(
    CTX,
    sources(["/a.sql", "SELECT status FROM customers;"], ["/b.sql", "SELECT status FROM orders;"]),
    ON_ORDERS,
  );
  assert.deepEqual(
    found.map((file) => file.path),
    ["/b.sql"],
  );
});

test("the source comes back with the hits, so the caller need not read it again", () => {
  const [file] = scan(CTX, sources(["/a.sql", "SELECT 1 FROM orders;"]), { name: "orders" });
  assert.equal(file?.src, "SELECT 1 FROM orders;");
});

test("a name nobody uses produces nothing at all", () => {
  assert.deepEqual(scan(CTX, sources(["/a.sql", "SELECT 1;"]), { name: "orders" }), []);
});
