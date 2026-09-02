/**
 * Symbols and inlay hints: the two features that describe a file rather than answer about a place
 * in it.
 *
 * They are together because they are read the same way — you open an outline or turn hints on and
 * look at the whole thing — and because both are about density. An outline that lists a procedure's
 * temporary tables, or a hint that repeats what an alias stands for on every line, is noise wearing
 * the clothes of information, and that is what most of these check.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { SymbolKind, type DocumentSymbol } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { Analysed } from "../src/documents.ts";
import { inlayHints } from "../src/features/inlay.ts";
import { documentSymbols, workspaceSymbols } from "../src/features/symbols.ts";
import { Workspace } from "../src/workspace.ts";

const SHOP = join(import.meta.dirname, "fixtures", "shop");
const AUDITED = join(import.meta.dirname, "fixtures", "audited");
const shop = new Workspace(SHOP);
const audited = new Workspace(AUDITED);

/** The kinds these two features use, named, because a bare `23` in an assertion says nothing. */
const KINDS: Record<number, string> = {
  [SymbolKind.Struct]: "struct",
  [SymbolKind.Field]: "field",
  [SymbolKind.Method]: "procedure",
  [SymbolKind.Function]: "function",
  [SymbolKind.Event]: "trigger",
};

function analysed(source: string, file = "sps/sp_scratch.sql", root = SHOP): Analysed {
  const document = TextDocument.create(pathToFileURL(join(root, file)).toString(), "sql", 1, source);
  return new Analysed(document);
}

/** A project file, read as the editor would have it open. */
function opened(root: string, file: string): Analysed {
  return analysed(readFileSync(join(root, file), "utf8"), file, root);
}

/** The outline as lines, nested children indented, which is how it is read on screen. */
function outline(symbols: DocumentSymbol[], depth = 0): string[] {
  const out: string[] = [];
  for (const symbol of symbols) {
    out.push(`${"  ".repeat(depth)}${KINDS[symbol.kind]} ${symbol.name} ${symbol.detail ?? ""}`.trimEnd());
    if (symbol.children) out.push(...outline(symbol.children, depth + 1));
  }
  return out;
}

// ------------------------------------------------------------- document symbols

test("a table's outline is the table with its columns under it", () => {
  assert.deepEqual(outline(documentSymbols(shop, opened(SHOP, "tables/orders.sql"))), [
    "struct orders 3 columns",
    "  field order_id int",
    "  field customer_id int",
    "  field total decimal(10,2)",
  ]);
});

test("triggers are in the outline, saying what they hang off", () => {
  // Their names are the least memorable thing in a schema, so the outline says what each one does
  // rather than leaving the name to carry it alone.
  assert.deepEqual(outline(documentSymbols(audited, opened(AUDITED, "tables/movements.sql"))).slice(-2), [
    "trigger movements_ai AFTER INSERT ON movements",
    "trigger movements_ad AFTER DELETE ON movements",
  ]);
});

test("a procedure comes first and carries its parameters", () => {
  // In a procedures file the routine is what the outline is opened for, whatever else is in there.
  assert.deepEqual(outline(documentSymbols(shop, opened(SHOP, "sps/sp_customer_report.sql"))), [
    "procedure sp_customer_report (pCustomerId int, OUT pTotal decimal(10,2))",
  ]);
});

test("a procedure's temporary tables are not the file's structure", () => {
  const source = `CREATE PROCEDURE \`sp_scratch\`()
BEGIN
  CREATE TEMPORARY TABLE tmp_orders (order_id int);
END;`;
  assert.deepEqual(outline(documentSymbols(shop, analysed(source))), ["procedure sp_scratch ()"]);
});

test("the outline follows the buffer, including what was never saved", () => {
  // The whole point of reading it from the text: an outline that came from the catalog would show
  // yesterday's file while you rewrite it.
  const source = "CREATE TABLE unsaved (\n  id int NOT NULL\n);";
  assert.deepEqual(outline(documentSymbols(shop, analysed(source, "tables/unsaved.sql"))), [
    "struct unsaved 1 columns",
    "  field id int",
  ]);
});

test("a symbol's selection range is the name inside its whole range", () => {
  // The protocol requires the one to contain the other, and a client that is sent otherwise draws
  // the outline's highlight over the wrong entry as the cursor moves.
  const [table] = documentSymbols(shop, opened(SHOP, "tables/orders.sql"));
  assert.ok(table);
  assert.equal(table.selectionRange.start.line, table.range.start.line);
  assert.ok(table.range.end.line > table.selectionRange.end.line);
});

// ------------------------------------------------------------ workspace symbols

/** What the picker would show, as `kind name`, sorted so the catalog's own order is not asserted. */
function picker(query: string, workspace = shop): string[] {
  return workspaceSymbols(workspace, query)
    .map((symbol) => `${KINDS[symbol.kind]} ${symbol.name}`)
    .sort();
}

test("the query matches anywhere in the name, ignoring case", () => {
  assert.deepEqual(picker("ORDER"), ["procedure sp_settle_orders", "struct orders"]);
});

test("an empty query is everything the project defines", () => {
  assert.deepEqual(picker(""), [
    "procedure sp_customer_report",
    "procedure sp_settle_orders",
    "struct customers",
    "struct orders",
    "struct shipments",
  ]);
});

test("a trigger says which table it belongs to, since its own name does not", () => {
  const trigger = workspaceSymbols(audited, "movements_ai")[0];
  assert.ok(trigger);
  assert.equal(trigger.containerName, "movements");
  assert.match(trigger.location.uri, /movements\.sql$/);
});

test("a query that matches nothing is answered with nothing", () => {
  assert.deepEqual(picker("no_such_thing"), []);
});

// -------------------------------------------------------------------- inlay hints

/** Each hint as `label@line:character`, which is the whole of what one is. */
function hints(source: string, file = "sps/sp_scratch.sql", workspace = shop, root = SHOP): string[] {
  return inlayHints(workspace, analysed(source, file, root)).map(
    (hint) => `${hint.label as string}@${hint.position.line}:${hint.position.character}`,
  );
}

test("a column reached through an alias is annotated with its type", () => {
  assert.deepEqual(hints("SELECT o.total FROM orders o;"), ["orders@0:8", ": decimal(10,2)@0:14"]);
});

test("what an alias stands for is said once per statement and not on every use", () => {
  // Measured: on every use it is as dense as the type hints while carrying nothing new. Once you
  // know `o` is `orders`, saying so twenty more times in the same statement is clutter.
  const labels = hints("SELECT o.total, o.customer_id, o.order_id FROM orders o;").filter(
    (hint) => !hint.startsWith(":"),
  );
  assert.deepEqual(labels, ["orders@0:8"]);
});

test("a new statement says it again, because the aliases are new too", () => {
  const source = "SELECT o.total FROM orders o;\nSELECT o.total FROM orders o;";
  assert.deepEqual(
    hints(source).filter((hint) => !hint.startsWith(":")),
    ["orders@0:8", "orders@1:8"],
  );
});

test("a table referred to by its own name earns no note saying so", () => {
  // `FROM customers` needs no hint reading `customers`. The types are still wanted.
  assert.deepEqual(hints("SELECT customers.email FROM customers;"), [": varchar(120)@0:22"]);
});

test("nothing is invented for a column the table does not have", () => {
  // That is `names/unknown-column`'s job, and a hint reading `: nil` would be worse than none.
  assert.deepEqual(hints("SELECT o.nonesuch FROM orders o;"), ["orders@0:8"]);
});

test("inside a trigger, NEW and OLD are the row of its table", () => {
  const source = readFileSync(join(AUDITED, "tables/movements.sql"), "utf8");
  const labels = hints(source, "tables/movements.sql", audited, AUDITED).filter((hint) => !hint.startsWith(":"));
  assert.deepEqual(labels, ["movements@12:87", "movements@17:87"]);
});

test("a range is honoured, so a long file costs only what is on screen", () => {
  const source = "SELECT o.total FROM orders o;\nSELECT s.state FROM shipments s;";
  const document = analysed(source);
  const second = { start: { line: 1, character: 0 }, end: { line: 1, character: 31 } };
  assert.deepEqual(
    inlayHints(shop, document, second).map((hint) => hint.label as string),
    ["shipments", ": char(1)"],
  );
});

test("a CALL's arguments are labelled with the parameters they fill", () => {
  // The signature is in another file: `(1, @t)` is the one place the line cannot explain itself.
  assert.deepEqual(hints("CALL sp_customer_report(1, @t);"), ["pCustomerId:@0:24", "OUT pTotal:@0:27"]);
});

test("an argument already written with the parameter's name earns no label", () => {
  // The same principle as an alias that is its table's own name: the label would be the code again.
  const src = "CREATE PROCEDURE sp_fwd(IN pCustomerId int, OUT pTotal decimal(10,2))\nBEGIN\n  CALL sp_customer_report(pCustomerId, pTotal);\nEND;";
  assert.deepEqual(hints(src), []);
});

test("only the positions the signature has, and a routine nothing defines gets none", () => {
  // `routine/call-arity` has already said the useful thing about the third argument.
  assert.deepEqual(hints("CALL sp_customer_report(1, @t, 3);"), ["pCustomerId:@0:24", "OUT pTotal:@0:27"]);
  assert.deepEqual(hints("CALL sp_nowhere(1, 2);"), []);
});

test("each kind can be turned off on its own", () => {
  const settings = shop.config.inlay_hints;
  try {
    shop.config.inlay_hints = { column_types: false, alias_tables: true, call_parameters: false };
    assert.deepEqual(hints("SELECT o.total FROM orders o;"), ["orders@0:8"]);

    shop.config.inlay_hints = { column_types: true, alias_tables: false, call_parameters: false };
    assert.deepEqual(hints("SELECT o.total FROM orders o;"), [": decimal(10,2)@0:14"]);

    shop.config.inlay_hints = { column_types: false, alias_tables: false, call_parameters: false };
    assert.deepEqual(hints("SELECT o.total FROM orders o;"), []);
    assert.deepEqual(hints("CALL sp_customer_report(1, @t);"), []);

    shop.config.inlay_hints = { column_types: false, alias_tables: false, call_parameters: true };
    assert.deepEqual(hints("CALL sp_customer_report(1, @t);"), ["pCustomerId:@0:24", "OUT pTotal:@0:27"]);
  } finally {
    shop.config.inlay_hints = settings;
  }
});
