/**
 * Hover, signature help and completion, against a fixture project.
 *
 * These call the features directly rather than over a connection. The connection is already held
 * down by `server.test.ts`, and what is at stake here is different: whether the right thing is said
 * about a position, which is a question about the schema and the cursor and not about JSON-RPC.
 *
 * The cursor is written into the source as a `|`, so a test reads as the thing somebody would
 * actually be looking at when they asked.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { CompletionItem, Hover, MarkupContent } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { Analysed, at, type At } from "../src/documents.ts";
import { complete, resolveItem } from "../src/features/completion.ts";
import { hover } from "../src/features/hover.ts";
import { signatureHelp } from "../src/features/signature.ts";
import { Workspace } from "../src/workspace.ts";

const SHOP = join(import.meta.dirname, "fixtures", "shop");
/** One catalog for the whole file: nothing here writes to the project. */
const workspace = new Workspace(SHOP);

/** Builds the request context for a source with the cursor marked `|`. */
function cursor(source: string, file = "sps/sp_scratch.sql"): At {
  const offset = source.indexOf("|");
  assert.notEqual(offset, -1, "the source has no | marking the cursor");

  const text = source.slice(0, offset) + source.slice(offset + 1);
  const document = TextDocument.create(pathToFileURL(join(SHOP, file)).toString(), "sql", 1, text);
  return at(workspace, new Analysed(document), document.positionAt(offset));
}

function markdown(result: Hover | undefined): string {
  assert.ok(result, "nothing was said about this position");
  return (result.contents as MarkupContent).value;
}

/** Labels in the order a client would show them, which is by `sortText` and not by arrival. */
function labels(source: string, file?: string): string[] {
  const items = complete(cursor(source, file), true).items;
  return [...items].sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)).map((i) => i.label);
}

function item(source: string, label: string, file?: string): CompletionItem {
  const found = complete(cursor(source, file), true).items.find((i) => i.label === label);
  assert.ok(found, `${label} was not offered; got ${JSON.stringify(labels(source, file).slice(0, 12))}`);
  return found;
}

// ------------------------------------------------------------------------ hover

test("a column says what it is and what it holds", () => {
  const text = markdown(hover(cursor("SELECT c.stat|us FROM customers c;")));
  assert.match(text, /customers\.status {2}char\(1\) NOT NULL/);
  assert.match(text, /DEFAULT `'A'`/);
});

test("a documented set of values is stated as fact", () => {
  // The `COMMENT` lists the whole set, so there is no hedge in the wording.
  const text = markdown(hover(cursor("SELECT c.stat|us FROM customers c;")));
  assert.match(text, /Values: `'A'` active · `'S'` suspended/);
});

test("what the procedures compare against is stated as what has been seen", () => {
  // `shipments.state` carries no comment. All that is known is the literals the procedures use, and
  // that is a lower bound rather than the set — so the wording says so.
  const text = markdown(hover(cursor("SELECT s.sta|te FROM shipments s;")));
  assert.match(text, /Seen holding: /);
  assert.match(text, /`'D'`/);
  assert.doesNotMatch(text, /Values:/);
});

test("a column that cannot hold a small set of codes says nothing about values", () => {
  const text = markdown(hover(cursor("SELECT o.to|tal FROM orders o;")));
  assert.doesNotMatch(text, /Values:|Seen holding:/);
});

test("a qualifier that resolves to nothing is not answered with the wrong column", () => {
  // `zz` names nothing. Falling back to any `status` in the catalog would be answering a question
  // nobody asked.
  assert.equal(hover(cursor("SELECT zz.stat|us FROM customers c;")), undefined);
});

test("a table is shown as its own CREATE TABLE", () => {
  const text = markdown(hover(cursor("SELECT * FROM ord|ers;")));
  assert.match(text, /```sql\nCREATE TABLE `orders`/);
  assert.match(text, /fk_orders_customer/);
});

test("an alias is shown as the table it stands for", () => {
  const text = markdown(hover(cursor("SELECT o.total FROM orders |o;")));
  assert.match(text, /CREATE TABLE `orders`/);
});

test("a routine is shown with its signature and its comment", () => {
  const text = markdown(hover(cursor("CALL sp_customer_re|port(1, @t);")));
  // `IN` is left off because it is the default; `OUT` is the one that has to be written down.
  assert.match(text, /sp_customer_report\(pCustomerId int, OUT pTotal decimal\(10,2\)\)/);
  assert.match(text, /Totals one customer's orders/);
});

test("a built-in function is recognised by the parenthesis stuck to it", () => {
  const text = markdown(hover(cursor("SELECT SU|M(o.total) FROM orders o;")));
  assert.match(text, /SUM\(expr\)/);
  assert.match(text, /\*MySQL aggregate function\*/);
});

test("a parameter is shown as a parameter, with its type", () => {
  const text = markdown(
    hover(
      cursor(`CREATE PROCEDURE \`sp_scratch\`(IN pCustomerId int)
BEGIN
  SELECT * FROM orders WHERE customer_id = pCustom|erId;
END;`),
    ),
  );
  assert.match(text, /pCustomerId int parameter/);
});

test("an unqualified column resolves against the statement's own tables", () => {
  const text = markdown(hover(cursor("SELECT ema|il FROM customers;")));
  assert.match(text, /customers\.email {2}varchar\(120\) NOT NULL/);
});

// --------------------------------------------------------------- signature help

test("a routine's parameters are listed, and an OUT is called out", () => {
  const help = signatureHelp(cursor("CALL sp_customer_report(|"));
  assert.ok(help);
  const [signature] = help.signatures;
  assert.match(signature!.label, /sp_customer_report\(/);
  assert.deepEqual(
    signature!.parameters?.map((p) => p.label),
    ["pCustomerId int", "OUT pTotal decimal(10,2)"],
  );
  // What you cannot see from the call site, and what makes passing a literal there a mistake.
  assert.match(String(signature!.parameters?.[1]?.documentation), /output parameter \(OUT\)/);
  assert.equal(help.activeParameter, 0);
});

test("the highlighted argument follows the commas", () => {
  assert.equal(signatureHelp(cursor("CALL sp_customer_report(1, |"))?.activeParameter, 1);
});

test("one argument too many stays on the last rather than pointing past the end", () => {
  assert.equal(signatureHelp(cursor("CALL sp_customer_report(1, @t, |"))?.activeParameter, 1);
});

test("a built-in's arguments are located inside its own signature text", () => {
  const help = signatureHelp(cursor("SELECT SUBSTRING_INDEX(x, |"));
  assert.ok(help);
  const signature = help.signatures[0]!;
  // Offsets into the label, not text: searching for the substring would find the wrong occurrence.
  const spans = signature.parameters!.map((p) => p.label as [number, number]);
  assert.deepEqual(
    spans.map(([from, to]) => signature.label.slice(from, to)),
    ["str", "delimiter", "count"],
  );
  assert.equal(help.activeParameter, 1);
});

test("nothing is offered outside a call", () => {
  assert.equal(signatureHelp(cursor("SELECT * FROM orders|")), undefined);
});

// ------------------------------------------------------------------ completion

test("after a dot, only that qualifier's columns", () => {
  assert.deepEqual(labels("SELECT o.| FROM orders o;"), ["order_id", "customer_id", "total"].sort());
});

test("after FROM, the catalog's tables", () => {
  const offered = labels("SELECT * FROM |");
  assert.deepEqual(offered, ["customers", "orders", "shipments"]);
});

test("after CALL, the project's routines and not the built-ins", () => {
  const offered = labels("CALL |");
  assert.deepEqual(offered, ["sp_customer_report", "sp_settle_orders"]);
});

test("an INSERT's column list offers that table's columns", () => {
  assert.deepEqual(labels("INSERT INTO shipments (|"), ["order_id", "shipment_id", "state"].sort());
});

test("a documented value is offered whole, quotes included", () => {
  // The position handled is the one *before* the opening quote: once a `'` is typed the lexer sees a
  // string running to the end of the file and there is no context left to work from.
  const offered = labels("SELECT * FROM customers c WHERE c.status = |");
  assert.equal(offered[0], "'A'");
  assert.equal(offered[1], "'S'");
  assert.equal(item("SELECT * FROM customers c WHERE c.status = |", "'A'").detail, "active");
});

test("values come first but do not crowd out what else is legal there", () => {
  // Unlike after a dot, the right-hand side of a comparison also takes a variable or a call.
  const offered = labels("SELECT * FROM customers c WHERE c.status = |");
  assert.ok(offered.includes("orders"), "the rest of what is legal here was dropped");
  assert.ok(offered.indexOf("'A'") < offered.indexOf("orders"));
});

test("an observed value says where it came from and a documented one does not", () => {
  const observed = item("SELECT * FROM shipments s WHERE s.state = |", "'D'");
  assert.match(String((observed.documentation as MarkupContent).value), /lower bound/);

  const documented = item("SELECT * FROM customers c WHERE c.status = |", "'A'");
  assert.equal(documented.documentation, undefined);
});

test("a column the table does not have offers no values at all", () => {
  const offered = labels("SELECT * FROM customers c WHERE c.nonesuch = |");
  assert.ok(!offered.some((label) => label.startsWith("'")));
});

test("built-ins come last, behind everything that belongs to this schema", () => {
  const offered = labels("SELECT | FROM orders o;");
  assert.ok(offered.indexOf("total") < offered.indexOf("orders"), "a column of the statement should lead");
  assert.ok(offered.indexOf("sp_settle_orders") < offered.indexOf("COALESCE"), "a built-in should trail");
});

test("a routine is inserted with its parameters as placeholders", () => {
  const offered = item("CALL |", "sp_customer_report");
  assert.equal(offered.textEdit?.newText, "sp_customer_report(${1:pCustomerId}, ${2:pTotal})");
  assert.equal(offered.insertTextFormat, 2);
});

test("accepting an item replaces the prefix instead of being pasted after it", () => {
  const offered = item("SELECT * FROM ord|", "orders");
  const edit = offered.textEdit!;
  assert.ok("range" in edit);
  assert.deepEqual(edit.range, { start: { line: 0, character: 14 }, end: { line: 0, character: 17 } });
});

test("the heavy documentation arrives only when an item is picked", () => {
  const offered = item("SELECT * FROM |", "orders");
  assert.equal(offered.documentation, undefined, "the whole CREATE TABLE should not travel with the list");

  const resolved = resolveItem(workspace, offered);
  assert.match(String((resolved.documentation as MarkupContent).value), /CREATE TABLE `orders`/);
});

test("a picked column is documented with the table it belongs to", () => {
  const resolved = resolveItem(workspace, item("SELECT o.| FROM orders o;", "total"));
  const text = String((resolved.documentation as MarkupContent).value);
  assert.match(text, /total decimal\(10,2\) NOT NULL/);
  assert.match(text, /In \*\*orders\*\*/);
});
