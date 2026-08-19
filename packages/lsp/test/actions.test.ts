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

import { CodeActionKind, type CodeAction, type TextEdit } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { diagnosticsOf } from "../src/convert.ts";
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

/**
 * The actions offered at a position, plus whatever quick fixes its own diagnostics earn — the same
 * two things a real client's request carries, `params.range` and `params.context.diagnostics`,
 * except here every diagnostic the workspace finds is handed over rather than only the ones a
 * client would have narrowed to the requested range: a quick fix only ever acts on the diagnostics
 * whose own location matches what it is about, so an unrelated one sitting in the list is inert.
 */
function actionsAt(here: At): CodeAction[] {
  return codeActions(here, diagnosticsOf(here.text, here.workspace.diagnose(here.text)));
}

/** The `Diagnostic`s a quick fix action carries, by `code` — what proves it is anchored to the
 * right finding and not offered unconditionally. */
function codesOf(action: CodeAction): (string | number | undefined)[] {
  return (action.diagnostics ?? []).map((d) => d.code);
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

// ------------------------------------------------------------------- quick fixes: audit sync

test("the audit-sync edits are quick fixes when a diagnostic is present, anchored to it", () => {
  const actions = actionsAt(inMovements());

  const columnFix = pick(actions, "Add note to aud_movements");
  assert.equal(columnFix.kind, CodeActionKind.QuickFix);
  assert.deepEqual(codesOf(columnFix), ["audit/table-out-of-sync"]);

  const triggerFix = pick(actions, "Rewrite the 2 audit triggers of movements");
  assert.equal(triggerFix.kind, CodeActionKind.QuickFix);
  assert.deepEqual(codesOf(triggerFix), ["audit/trigger-missing-column", "audit/trigger-missing-column"]);
});

// ------------------------------------------------------------------- quick fixes: did you mean

test("an unknown table is renamed to the one catalog name close enough", () => {
  const here = cursor("SELECT * FROM |ordrs;");
  const action = pick(actionsAt(here), "Rename to orders");
  assert.deepEqual(codesOf(action), ["names/unknown-table"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    "SELECT * FROM orders;",
  );
});

test("nothing is close enough, so no rename is offered", () => {
  const here = cursor("SELECT * FROM |zzzzzzz;");
  assert.deepEqual(
    actionsAt(here).filter((a) => a.title.startsWith("Rename to")),
    [],
  );
});

test("an unknown routine is renamed to the one call close enough", () => {
  const here = cursor("CALL |sp_settle_order();");
  const action = pick(actionsAt(here), "Rename to sp_settle_orders");
  assert.deepEqual(codesOf(action), ["names/unknown-routine"]);
});

test("an unknown alias is renamed to the one this statement declares", () => {
  const here = cursor("SELECT |o.total FROM orders ord;");
  const action = pick(actionsAt(here), "Rename to ord");
  assert.deepEqual(codesOf(action), ["names/unknown-alias"]);
});

test("an unknown qualified column is renamed to the table's one close enough", () => {
  const here = cursor("SELECT o.|tootal FROM orders o;");
  const action = pick(actionsAt(here), "Rename to total");
  assert.deepEqual(codesOf(action), ["names/unknown-column"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    "SELECT o.total FROM orders o;",
  );
});

test("a bare unknown column is renamed against every table the statement resolves", () => {
  const here = cursor("SELECT |toal FROM orders;");
  const action = pick(actionsAt(here), "Rename to total");
  assert.deepEqual(codesOf(action), ["names/unqualified-column"]);
});

test("an unknown INSERT column is renamed to the target table's one close enough", () => {
  const here = cursor("INSERT INTO orders (order_id, |custmer_id, total) VALUES (1, 2, 3);");
  const action = pick(actionsAt(here), "Rename to customer_id");
  assert.deepEqual(codesOf(action), ["query/insert-unknown-column"]);
});

test("a foreign key pointing at an unknown table is renamed to the one catalog name close enough", () => {
  const here = cursor(
    `CREATE TABLE t (
  id INT,
  customer_id INT,
  CONSTRAINT fk_t_cust FOREIGN KEY (customer_id) REFERENCES |custmers (customer_id)
);`,
    "tables/t.sql",
  );
  const action = pick(actionsAt(here), "Rename to customers");
  assert.deepEqual(codesOf(action), ["schema/fk-unknown-table"]);
});

test("a foreign key's own unknown column is renamed against its own table", () => {
  const here = cursor(
    `CREATE TABLE t (
  id INT,
  customer_id INT,
  CONSTRAINT fk_t FOREIGN KEY (|custmer_id) REFERENCES customers (customer_id)
);`,
    "tables/t.sql",
  );
  const action = pick(actionsAt(here), "Rename to customer_id");
  assert.deepEqual(codesOf(action), ["schema/fk-unknown-column"]);
});

test("a foreign key's unknown referenced column is renamed against the target table", () => {
  const here = cursor(
    `CREATE TABLE t2 (
  id INT,
  customer_id INT,
  CONSTRAINT fk_t2 FOREIGN KEY (customer_id) REFERENCES customers (|custmer_id)
);`,
    "tables/t2.sql",
  );
  const action = pick(actionsAt(here), "Rename to customer_id");
  assert.deepEqual(codesOf(action), ["schema/fk-unknown-column"]);
});

test("an index over an unknown column is renamed against its own table", () => {
  const here = cursor(
    `CREATE TABLE t3 (
  id INT,
  customer_id INT,
  KEY ix_cust (|custmer_id)
);`,
    "tables/t3.sql",
  );
  const action = pick(actionsAt(here), "Rename to customer_id");
  assert.deepEqual(codesOf(action), ["schema/index-unknown-column"]);
});

// ------------------------------------------------------------------- quick fixes: structural

test("an unused variable's DECLARE is removed whole", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_x()
BEGIN
  DECLARE |v INT;
  SELECT 1;
END;`,
  );
  const action = pick(actionsAt(here), "Remove unused variable v");
  assert.deepEqual(codesOf(action), ["routine/unused-variable"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_x()
BEGIN
  SELECT 1;
END;`,
  );
});

test("a variable co-declared with others loses just its own name, not the whole DECLARE", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_x()
BEGIN
  DECLARE |v, w INT;
  SELECT w;
END;`,
  );
  const action = pick(actionsAt(here), "Remove unused variable v");
  assert.deepEqual(codesOf(action), ["routine/unused-variable"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_x()
BEGIN
  DECLARE w INT;
  SELECT w;
END;`,
  );
});

test("the first of three co-declared names leaves the rest of the list untouched", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_x2()
BEGIN
  DECLARE |v, w, x INT;
  SELECT w, x;
END;`,
  );
  const action = pick(actionsAt(here), "Remove unused variable v");
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_x2()
BEGIN
  DECLARE w, x INT;
  SELECT w, x;
END;`,
  );
});

test("the last of three co-declared names takes the comma before it, not after", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_x3()
BEGIN
  DECLARE v, w, |x INT;
  SELECT v, w;
END;`,
  );
  const action = pick(actionsAt(here), "Remove unused variable x");
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_x3()
BEGIN
  DECLARE v, w INT;
  SELECT v, w;
END;`,
  );
});

test("a DECLARE after the block's first statement is moved to the top", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_y()
BEGIN
  SELECT 1;
  |DECLARE v INT;
END;`,
  );
  const action = pick(actionsAt(here), "Move this DECLARE above the block's first statement");
  assert.deepEqual(codesOf(action), ["routine/declare-after-statement"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_y()
BEGIN
  DECLARE v INT;
  SELECT 1;
END;`,
  );
});

test("a HANDLER's DECLARE earns no move — the shape is not the plain one this scan reads", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_z()
BEGIN
  SELECT 1;
  |DECLARE CONTINUE HANDLER FOR NOT FOUND BEGIN SET @done = 1; END;
END;`,
  );
  assert.deepEqual(
    actionsAt(here).filter((a) => a.title.startsWith("Move this DECLARE")),
    [],
  );
});

test("a cursor never opened is removed whole — a cursor has no sibling form to guard against", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_c()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE |cur CURSOR FOR SELECT order_id FROM orders;
  SELECT done;
END;`,
  );
  const action = pick(actionsAt(here), "Remove cursor cur");
  assert.deepEqual(codesOf(action), ["routine/cursor-never-opened"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_c()
BEGIN
  DECLARE done INT DEFAULT 0;
  SELECT done;
END;`,
  );
});

test("a redundant index is dropped, comma and all", () => {
  const here = cursor(
    `CREATE TABLE t (
  a INT,
  b INT,
  |KEY ix_a (a),
  KEY ix_ab (a, b)
);`,
    "tables/t.sql",
  );
  const action = pick(actionsAt(here), "Remove ix_a");
  assert.deepEqual(codesOf(action), ["schema/redundant-index"]);
  assert.equal(
    applied(action, join(SHOP, "tables/t.sql"), here.text),
    `CREATE TABLE t (
  a INT,
  b INT,
  KEY ix_ab (a, b)
);`,
  );
});

test("a foreign key with nothing to check it against gets an index on the table it references", () => {
  // `customers.status` has no index of its own — only `customer_id` (its primary key) and `email`
  // (a unique key) do — so a foreign key referencing it earns `schema/fk-missing-index`.
  const here = cursor(
    `CREATE TABLE t4 (
  id INT,
  cust_status CHAR(1),
  CONSTRAINT fk_t4_status FOREIGN KEY (cust_status) REFERENCES |customers (status)
);`,
    "tables/t4.sql",
  );
  const action = pick(actionsAt(here), "Add an index on customers (status)");
  assert.deepEqual(codesOf(action), ["schema/fk-missing-index"]);
  assert.equal(
    applied(action, join(SHOP, "tables/customers.sql"), readFileSync(join(SHOP, "tables/customers.sql"), "utf8")),
    `CREATE TABLE \`customers\` (
  \`customer_id\` int NOT NULL AUTO_INCREMENT,
  \`email\` varchar(120) NOT NULL,
  \`status\` char(1) NOT NULL DEFAULT 'A' COMMENT 'A=active, S=suspended',
  PRIMARY KEY (\`customer_id\`),
  UNIQUE KEY \`uq_email\` (\`email\`),
  KEY ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`,
  );
});

// ------------------------------------------------------------------- quick fixes: INSERT regeneration

test("an under-supplied VALUES tuple is completed with markers for what is missing", () => {
  const path = join(SHOP, "sps/sp_settle_orders.sql");
  const src = readFileSync(path, "utf8");
  const document = TextDocument.create(pathToFileURL(path).toString(), "sql", 1, src);
  const here = at(shop, new Analysed(document), document.positionAt(src.indexOf("(1, pCustomerId)")));

  const action = pick(actionsAt(here), "Add 1 missing value(s)");
  assert.deepEqual(codesOf(action), ["query/insert-value-count"]);
  assert.equal(
    applied(action, path, src),
    `CREATE PROCEDURE \`sp_settle_orders\`(IN pCustomerId int)
BEGIN
  INSERT INTO orders (order_id, customer_id, total) VALUES (1, pCustomerId, /* total */);
END;
`,
  );
});

test("an over-supplied VALUES tuple earns no fix — which extra value is wrong is not knowable", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_over()
BEGIN
  INSERT INTO orders (order_id, customer_id) VALUES |(1, 2, 3);
END;`,
  );
  assert.deepEqual(
    actionsAt(here).filter((a) => a.title.startsWith("Add") && a.title.includes("missing value")),
    [],
  );
});

test("a missing required column is appended to the list and marked in the VALUES tuple", () => {
  const here = cursor(
    `CREATE PROCEDURE sp_missing()
BEGIN
  INSERT INTO orders |(order_id) VALUES (1);
END;`,
  );
  const action = pick(actionsAt(here), "Add customer_id, total to the INSERT");
  assert.deepEqual(codesOf(action), ["query/insert-missing-required-column"]);
  assert.equal(
    applied(action, join(SHOP, "sps/sp_scratch.sql"), here.text),
    `CREATE PROCEDURE sp_missing()
BEGIN
  INSERT INTO orders (order_id, customer_id, total) VALUES (1, /* customer_id */, /* total */);
END;`,
  );
});

test("a missing required column into a SELECT-fed insert earns no fix", () => {
  // There is no mechanical value to add to a select list — only the `VALUES` form is fixed.
  const here = cursor(
    `CREATE PROCEDURE sp_missing_select()
BEGIN
  INSERT INTO orders |(order_id) SELECT order_id FROM orders;
END;`,
  );
  assert.deepEqual(
    actionsAt(here).filter((a) => a.title.endsWith("to the INSERT")),
    [],
  );
});
