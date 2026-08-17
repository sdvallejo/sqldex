/**
 * References, rename and call hierarchy, against fixture projects.
 *
 * Two projects, because the questions need different shapes of repo: `shop` has tables and columns
 * with uses spread over its procedures, and `chain` is procedures that call each other.
 *
 * As in `features.test.ts` the cursor is written into the source as a `|`, and these call the
 * features directly: the connection is held down by `server.test.ts`, and what is at stake here is
 * what gets answered rather than how it travels.
 *
 * Unlike hover and completion, these read the project **from disk** — a use in a file nobody has
 * opened is exactly what is being looked for — so the fixtures are real directories and the paths
 * in the assertions are real files.
 */

import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CallHierarchyItem, Location, TextEdit } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { Analysed, at, type At } from "../src/documents.ts";
import { incomingCalls, outgoingCalls, prepareCallHierarchy } from "../src/features/call-hierarchy.ts";
import { references } from "../src/features/references.ts";
import { prepareRename, rename } from "../src/features/rename.ts";
import { Workspace } from "../src/workspace.ts";

const SHOP = join(import.meta.dirname, "fixtures", "shop");
const CHAIN = join(import.meta.dirname, "fixtures", "chain");
const shop = new Workspace(SHOP);
const chain = new Workspace(CHAIN);

/** Builds the request context for a source with the cursor marked `|`. */
function cursorIn(workspace: Workspace, root: string, source: string, file: string): At {
  const offset = source.indexOf("|");
  assert.notEqual(offset, -1, "the source has no | marking the cursor");

  const text = source.slice(0, offset) + source.slice(offset + 1);
  const document = TextDocument.create(pathToFileURL(join(root, file)).toString(), "sql", 1, text);
  return at(workspace, new Analysed(document), document.positionAt(offset));
}

/** The open file defaults to one the project does not have, so the buffer is all there is of it. */
function cursor(source: string, file = "sps/sp_scratch.sql"): At {
  return cursorIn(shop, SHOP, source, file);
}

function inChain(source: string, file = "sps/sp_scratch.sql"): At {
  return cursorIn(chain, CHAIN, source, file);
}

/** Which files answered, and how many times each, keyed by the name somebody would recognise. */
function byFile(locations: Location[] | undefined): Record<string, number> {
  assert.ok(locations, "nothing was said about this position");
  const counts: Record<string, number> = {};
  for (const location of locations) {
    const name = basename(fileURLToPath(location.uri));
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** The item a client would send back on a follow-up request, taken from `prepare` as one would. */
function hierarchyItem(name: string): CallHierarchyItem {
  // The cursor sits one character short of the end: an offset level with the end of a token is
  // already past it.
  const source = `CALL ${name.slice(0, -1)}|${name.slice(-1)}();`;
  const items = prepareCallHierarchy(inChain(source));
  assert.ok(items && items.length === 1, `${name} has no call hierarchy`);
  return items[0]!;
}

function callers(name: string): string[] {
  return (incomingCalls(chain, hierarchyItem(name)) ?? []).map((call) => call.from.name);
}

function callees(name: string): string[] {
  return (outgoingCalls(chain, hierarchyItem(name)) ?? []).map((call) => call.to.name);
}

// ------------------------------------------------------------------ references

test("a table's uses are found in files nobody opened", () => {
  // The point of the whole scan: `shipments.sql` names `orders` in a foreign key and neither the
  // buffer nor the catalog would ever have said so.
  assert.deepEqual(byFile(references(cursor("SELECT * FROM ord|ers;"))), {
    "orders.sql": 1,
    "shipments.sql": 1,
    "sp_customer_report.sql": 2,
    "sp_settle_orders.sql": 1,
    "sp_scratch.sql": 1,
  });
});

test("a column is looked for only where its own table is", () => {
  // `total` on its own would also mean the `pTotal` of a procedure and any other table's column
  // by that name. Scoped to `orders`, it is the two places that really read it.
  assert.deepEqual(byFile(references(cursor("SELECT o.tot|al FROM orders o;"))), {
    "sp_customer_report.sql": 1,
    "sp_settle_orders.sql": 1,
    "sp_scratch.sql": 1,
  });
});

test("a parameter is looked for inside its own file and nowhere else", () => {
  const found = references(
    cursor(
      `CREATE PROCEDURE \`sp_scratch\`(IN pCustomerId int)
BEGIN
  SELECT * FROM orders WHERE customer_id = pCustom|erId;
END;`,
    ),
  );
  // `pCustomerId` is also a parameter of both fixture procedures, and means a different thing in
  // each: a project-wide answer here would be a list of other people's variables.
  assert.deepEqual(byFile(found), { "sp_scratch.sql": 2 });
});

test("the open file is read from the buffer and not from disk", () => {
  // Two uses on disk, one in the buffer. Being told about a line just deleted is worse than not
  // asking.
  const found = references(
    cursor("SELECT SUM(o.total) FROM ord|ers o;", "sps/sp_customer_report.sql"),
  );
  assert.equal(byFile(found)["sp_customer_report.sql"], 1);
});

test("a qualifier that resolves to nothing is not answered with some other table's column", () => {
  assert.equal(references(cursor("SELECT zz.tot|al FROM orders o;")), undefined);
});

test("a cursor that is not on an identifier is not answered", () => {
  assert.equal(references(cursor("SELECT * FROM| orders;")), undefined);
});

// ---------------------------------------------------------------------- rename

/** Every edit of a workspace edit, flattened, since what matters is what each one writes. */
function edits(edit: { changes?: Record<string, TextEdit[]> } | undefined): TextEdit[] {
  assert.ok(edit?.changes, "no edit was produced");
  return Object.values(edit.changes).flat();
}

test("a rename reaches every file that uses the name", () => {
  const edit = rename(cursor("SELECT * FROM ord|ers;"), "purchases");
  assert.ok(edit?.changes);
  // The same five files references reports, and one edit per use in them.
  assert.deepEqual(
    Object.keys(edit.changes)
      .map((uri) => basename(fileURLToPath(uri)))
      .sort(),
    ["orders.sql", "shipments.sql", "sp_customer_report.sql", "sp_scratch.sql", "sp_settle_orders.sql"],
  );
  assert.equal(edits(edit).length, 6);
});

test("a use that had backticks keeps them", () => {
  // `tables/orders.sql` writes the name delimited; a column called `` `order` `` stops being valid
  // the moment they come off, so they are preserved wherever they were.
  const written = new Set(edits(rename(cursor("SELECT * FROM ord|ers;"), "purchases")).map((e) => e.newText));
  assert.deepEqual([...written].sort(), ["`purchases`", "purchases"]);
});

test("backticks are added when the new name needs them", () => {
  const all = edits(rename(cursor("SELECT * FROM ord|ers;"), "my orders"));
  assert.ok(
    all.every((one) => one.newText === "`my orders`"),
    "a name with a space has to be written delimited everywhere",
  );
});

test("a name containing the delimiter is escaped rather than broken", () => {
  const all = edits(rename(cursor("SELECT * FROM ord|ers;"), "we`ird"));
  assert.equal(all[0]?.newText, "`we``ird`");
});

test("an empty new name is refused", () => {
  assert.equal(rename(cursor("SELECT * FROM ord|ers;"), ""), undefined);
});

test("preparing offers the catalog's spelling and the range to replace", () => {
  const prepared = prepareRename(cursor("SELECT * FROM ORD|ERS;"));
  assert.ok(prepared);
  // What is under the cursor is `ORDERS`; what is being renamed is `orders`.
  assert.equal(prepared.placeholder, "orders");
  assert.deepEqual(prepared.range, {
    start: { line: 0, character: 14 },
    end: { line: 0, character: 20 },
  });
});

test("preparing says nothing where there is nothing to rename", () => {
  assert.equal(prepareRename(cursor("SELECT * FROM| orders;")), undefined);
});

// -------------------------------------------------------------- call hierarchy

test("the routine under the cursor is offered, with where it is defined", () => {
  const [item] = prepareCallHierarchy(inChain("CALL sp_sett|le();")) ?? [];
  assert.ok(item);
  assert.equal(item.name, "sp_settle");
  // `Method`, which is what a procedure is shown as everywhere else.
  assert.equal(item.kind, 6);
  assert.equal(fileURLToPath(item.uri), join(CHAIN, "sps", "sp_settle.sql"));
  // Both ranges are the name: the catalog records where that is, not where the body ends.
  assert.deepEqual(item.range, item.selectionRange);
});

test("nothing is offered over a name that is not a routine", () => {
  assert.equal(prepareCallHierarchy(inChain("SELECT * FROM jo|bs;")), undefined);
});

test("who calls a procedure comes back in a fixed order", () => {
  assert.deepEqual(callers("sp_settle"), ["sp_nightly", "sp_pair_first", "sp_settle_batch"]);
});

test("several call sites are gathered under the one caller", () => {
  // Three `CALL`s from the same procedure are one answer to "who do I break", not three.
  const calls = incomingCalls(chain, hierarchyItem("sp_settle")) ?? [];
  const nightly = calls.find((call) => call.from.name === "sp_nightly");
  assert.equal(nightly?.fromRanges.length, 2);
});

test("a mention in a comment or a string is not a call", () => {
  // The whole difference from grepping for the name: `sp_report` writes it twice and calls it
  // never.
  assert.ok(!callers("sp_settle").includes("sp_report"));
});

test("a longer name that contains it is a different routine", () => {
  assert.deepEqual(callees("sp_settle_batch"), ["sp_settle"]);
});

test("a call written in another case is still a call", () => {
  // `sp_settle_batch` writes `CALL SP_SETTLE()`.
  assert.ok(callers("sp_settle").includes("sp_settle_batch"));
});

test("a routine nobody calls reports nothing rather than failing", () => {
  assert.deepEqual(callers("sp_nightly"), []);
});

test("what a procedure calls leaves out what the project does not define", () => {
  // `sp_nightly` also calls `sp_vanished`, which is not in the catalog: an item pointing at no
  // file is not something a client can open.
  assert.deepEqual(callees("sp_nightly"), ["sp_report", "sp_settle", "sp_settle_batch"]);
});

test("repeated calls to the same routine are gathered too", () => {
  const calls = outgoingCalls(chain, hierarchyItem("sp_nightly")) ?? [];
  assert.equal(calls.find((call) => call.to.name === "sp_settle")?.fromRanges.length, 2);
});

test("in a file with two routines, each one owns only its own calls", () => {
  // A routine's body has no recorded end, so each one runs to the next one's name.
  assert.deepEqual(callees("sp_pair_first"), ["sp_settle"]);
  assert.deepEqual(callees("sp_pair_second"), ["sp_report"]);
});
