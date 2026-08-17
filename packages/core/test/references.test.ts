/**
 * Finding a name's uses, over sources written out in the test.
 *
 * The whole module is a question about text, so a fixture directory would only put a filesystem
 * between the case and what it is about. Where the hits *go* — URIs, ranges, an edit — is the
 * language server's problem and is checked there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { find, scan, type FileSource, type RefTarget } from "../src/analysis/references.ts";
import { mysql } from "../src/dialects/mysql/index.ts";

/** The hits as the substrings they cover, which is what the assertions read best. */
function hits(src: string, target: RefTarget): string[] {
  return find(mysql, src, target).map((ref) => src.slice(ref.s, ref.e));
}

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
  const found = find(mysql, "SELECT o.status, status FROM orders o;", { name: "status" });
  assert.equal(found.length, 2);
  assert.equal(found[0]!.qualified, true);
  assert.equal(found[1]!.qualified, false);
});

test("each hit says whether it was written delimited", () => {
  const found = find(mysql, "SELECT `status`, status FROM orders;", { name: "status" });
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

test("a column's own CREATE TABLE is not reached by an owner-scoped search", () => {
  // A `CREATE TABLE` declares no relation, so the statement never "involves" the table it defines.
  // The declaration is where the column comes from rather than a use of it, and in a repo whose
  // DDL files are regenerated from the server it is not the copy anybody edits by hand.
  assert.deepEqual(hits("CREATE TABLE `orders` (`status` char(1) NOT NULL);", ON_ORDERS), []);
});

// ------------------------------------------------------------- over a project

test("a file that never mentions the name is never lexed", () => {
  const found = scan(mysql, sources(["/a.sql", "SELECT 1 FROM orders;"], ["/b.sql", "SELECT 1 FROM customers;"]), {
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
    mysql,
    sources(["/a.sql", "SELECT status FROM customers;"], ["/b.sql", "SELECT status FROM orders;"]),
    ON_ORDERS,
  );
  assert.deepEqual(
    found.map((file) => file.path),
    ["/b.sql"],
  );
});

test("the source comes back with the hits, so the caller need not read it again", () => {
  const [file] = scan(mysql, sources(["/a.sql", "SELECT 1 FROM orders;"]), { name: "orders" });
  assert.equal(file?.src, "SELECT 1 FROM orders;");
});

test("a name nobody uses produces nothing at all", () => {
  assert.deepEqual(scan(mysql, sources(["/a.sql", "SELECT 1;"]), { name: "orders" }), []);
});
