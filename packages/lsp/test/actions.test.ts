/**
 * Code actions: the text the catalog can write for you.
 *
 * What is asserted is mostly the **result of applying the edit**, not its offsets. An action is
 * judged by the file it leaves behind — a `CREATE TABLE` that still parses, a trigger that carries
 * every column — and a range that is right by one produces something that looks fine in a diff and
 * does not run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodeAction, TextEdit } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { Analysed, at, type At } from "../src/documents.ts";
import { codeActions } from "../src/features/code-action.ts";
import { Workspace } from "../src/workspace.ts";

const SHOP = join(import.meta.dirname, "fixtures", "shop");
const AUDITED = join(import.meta.dirname, "fixtures", "audited");
const shop = new Workspace(SHOP);
const audited = new Workspace(AUDITED);

/** The request context for a source with the cursor marked `|`, as in the other feature tests. */
function cursorIn(workspace: Workspace, root: string, source: string, file: string): At {
  const offset = source.indexOf("|");
  assert.notEqual(offset, -1, "the source has no | marking the cursor");

  const text = source.slice(0, offset) + source.slice(offset + 1);
  const document = TextDocument.create(pathToFileURL(join(root, file)).toString(), "sql", 1, text);
  return at(workspace, new Analysed(document), document.positionAt(offset));
}

function cursor(source: string, file = "sps/sp_scratch.sql"): At {
  return cursorIn(shop, SHOP, source, file);
}

function titles(actions: CodeAction[]): string[] {
  return actions.map((action) => action.title);
}

/** The action with this title, which is how a person picks one out of the menu. */
function pick(actions: CodeAction[], title: string): CodeAction {
  const found = actions.find((action) => action.title === title);
  assert.ok(found, `no action titled ${title}; there were ${JSON.stringify(titles(actions))}`);
  return found;
}

/** The edits an action makes to one file, keyed the way the protocol keys them. */
function editsTo(action: CodeAction, path: string): TextEdit[] {
  const changes = action.edit?.changes ?? {};
  const uri = Object.keys(changes).find((key) => fileURLToPath(key) === path);
  assert.ok(uri, `the action touches ${Object.keys(changes).length} files, none of them ${path}`);
  return changes[uri]!;
}

/** What a source looks like once an action has been applied to it. */
function applied(action: CodeAction, path: string, src: string): string {
  const document = TextDocument.create(pathToFileURL(path).toString(), "sql", 1, src);
  return TextDocument.applyEdits(document, editsTo(action, path));
}

// -------------------------------------------------------------------- expanding

test("a qualified star expands into the columns, qualifier and all", () => {
  // The qualifier is kept because that is the form that survives another table being joined in
  // later, which is the edit that usually follows this one.
  const here = cursor("SELECT o.|* FROM orders o;");
  const action = pick(codeActions(here), "Expand o.* into its 3 columns");
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    "SELECT o.order_id, o.customer_id, o.total FROM orders o;",
  );
});

test("a bare star over a single table expands too", () => {
  const here = cursor("SELECT |* FROM orders;");
  const action = pick(codeActions(here), "Expand * into its 3 columns");
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    "SELECT order_id, customer_id, total FROM orders;",
  );
});

test("a bare star over a join is left alone", () => {
  // Which columns it means, and in what order, is the server's business. Guessing would produce a
  // list that silently differs from what runs today, which is worse than offering nothing.
  const here = cursor("SELECT |* FROM orders o JOIN shipments s ON s.order_id = o.order_id;");
  assert.deepEqual(titles(codeActions(here)), []);
});

test("a star over something with no columns to name offers nothing", () => {
  assert.deepEqual(titles(codeActions(cursor("SELECT |* FROM nonesuch;"))), []);
});

// ------------------------------------------------------------------- generating

test("the three statements are offered over a table's name", () => {
  assert.deepEqual(titles(codeActions(cursor("orde|rs"))), [
    "Generate SELECT over orders",
    "Generate INSERT into orders",
    "Generate UPDATE of orders",
  ]);
});

test("a generated INSERT names its columns and marks every slot", () => {
  // A positional `INSERT` that has fallen behind its table is the bug `query/insert-value-count`
  // exists to catch. A generated statement should not be able to join them.
  const here = cursor("orde|rs");
  assert.equal(
    applied(pick(codeActions(here), "Generate INSERT into orders"), join(SHOP, "sps/sp_scratch.sql"), here.text),
    `INSERT INTO orders (customer_id, total)
VALUES (/* customer_id */, /* total */)`,
  );
});

test("a generated UPDATE is keyed on the primary key and leaves it out of the SET", () => {
  const here = cursor("orde|rs");
  assert.equal(
    applied(pick(codeActions(here), "Generate UPDATE of orders"), join(SHOP, "sps/sp_scratch.sql"), here.text),
    `UPDATE orders
SET customer_id = /* customer_id */, total = /* total */
WHERE order_id = /* order_id */`,
  );
});

test("a generated SELECT names every column, auto-increment included", () => {
  const here = cursor("orde|rs");
  assert.equal(
    applied(pick(codeActions(here), "Generate SELECT over orders"), join(SHOP, "sps/sp_scratch.sql"), here.text),
    `SELECT order_id, customer_id, total
FROM orders`,
  );
});

test("nothing is generated over a name the project does not define", () => {
  assert.deepEqual(titles(codeActions(cursor("nonesu|ch"))), []);
});

test("nothing is generated over a qualified name, which is a column", () => {
  assert.deepEqual(titles(codeActions(cursor("SELECT o.tot|al FROM orders o;"))), []);
});

// ------------------------------------------------------------------- audit twins

const MOVEMENTS = join(AUDITED, "tables/movements.sql");
const TWIN = join(AUDITED, "tables/aud_movements.sql");

/** The cursor inside the `CREATE TABLE` of the audited fixture, as it is opened from disk. */
function inMovements(marker = "`note`"): At {
  const src = readFileSync(MOVEMENTS, "utf8");
  const offset = src.indexOf(marker) + 1;
  const document = TextDocument.create(pathToFileURL(MOVEMENTS).toString(), "sql", 1, src);
  return at(audited, new Analysed(document), document.positionAt(offset));
}

test("the twin and the triggers are two actions, because they are two files", () => {
  // One is useful without the other: the columns go into the twin's file, the triggers live beside
  // the table the cursor is on, and either can be wanted on its own.
  assert.deepEqual(titles(codeActions(inMovements())), [
    "Add note to aud_movements",
    "Rewrite the 2 audit triggers of movements",
  ]);
});

test("the missing column lands in the twin where the table has it", () => {
  const action = pick(codeActions(inMovements()), "Add note to aud_movements");
  assert.equal(
    applied(action, TWIN, readFileSync(TWIN, "utf8")),
    `CREATE TABLE \`aud_movements\` (
  \`aud_id\` int NOT NULL AUTO_INCREMENT,
  \`aud_at\` datetime NOT NULL,
  \`aud_by\` varchar(60) NOT NULL,
  \`aud_action\` char(1) NOT NULL,
  \`movement_id\` int NOT NULL,
  \`account_id\` int NOT NULL,
  \`amount\` decimal(10,2) NOT NULL,
  \`note\` varchar(200) DEFAULT NULL,
  PRIMARY KEY (\`aud_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`,
  );
});

test("both triggers come out carrying every column, each with its own qualifier", () => {
  const action = pick(codeActions(inMovements()), "Rewrite the 2 audit triggers of movements");
  const out = applied(action, MOVEMENTS, readFileSync(MOVEMENTS, "utf8"));
  assert.match(out, /'I', NEW\.movement_id, NEW\.account_id, NEW\.amount, NEW\.note\)/);
  assert.match(out, /'D', OLD\.movement_id, OLD\.account_id, OLD\.amount, OLD\.note\)/);
  // The bookkeeping slots are none of the rewrite's business and are still there.
  assert.equal(out.match(/SUBSTRING_INDEX\(USER\(\), '@', 1\)/g)?.length, 2);
});

test("a cursor sitting in a trigger still means the file's table", () => {
  // It is past the `CREATE TABLE` and inside no table at all, which is where the action is most
  // likely to be asked for: you are looking at the trigger that is behind.
  assert.deepEqual(titles(codeActions(inMovements("NEW.movement_id"))), [
    "Add note to aud_movements",
    "Rewrite the 2 audit triggers of movements",
  ]);
});

test("a table with no twin is not audited, so there is nothing to sync", () => {
  const src = readFileSync(join(SHOP, "tables/orders.sql"), "utf8");
  const path = join(SHOP, "tables/orders.sql");
  const document = TextDocument.create(pathToFileURL(path).toString(), "sql", 1, src);
  const here = at(shop, new Analysed(document), document.positionAt(src.indexOf("`total`") + 1));
  assert.deepEqual(titles(codeActions(here)), []);
});

test("a file that defines no table is never even parsed for one", () => {
  assert.deepEqual(titles(codeActions(cursor("SELECT 1 FROM du|al;"))), []);
});
