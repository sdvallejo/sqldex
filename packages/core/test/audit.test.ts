/**
 * The arithmetic of repairing an audit twin, over tables written out in the test.
 *
 * The module produces offsets and text and nothing else, so what is checked here is the text a
 * caller would end up with after applying what it says. Turning that into a code action, with the
 * URIs and the ranges, is the language server's problem and is checked there.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditDefinition,
  auditTableName,
  insertions,
  missingColumns,
  prefixCount,
  triggerInserts,
} from "../src/analysis/audit.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";
import type { Table } from "../src/model/table.ts";

/** The table a source defines, by name, so a case can hold a table and its twin at once. */
function tableIn(src: string, name: string): Table {
  const found = parseDDL(mysql, src, tokenize(src)).tables.find((table) => table.name === name);
  assert.ok(found, `${name} is not defined in this source`);
  return found;
}

const MOVEMENTS = `CREATE TABLE movements (
  movement_id int NOT NULL AUTO_INCREMENT,
  account_id int NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(200) DEFAULT NULL,
  PRIMARY KEY (movement_id)
);`;

const TWIN = `CREATE TABLE aud_movements (
  aud_id int NOT NULL AUTO_INCREMENT,
  aud_at datetime NOT NULL,
  movement_id int NOT NULL,
  account_id int NOT NULL,
  amount decimal(10,2) NOT NULL,
  PRIMARY KEY (aud_id)
);`;

const movements = tableIn(MOVEMENTS, "movements");
const twin = tableIn(TWIN, "aud_movements");

/** The twin's source with every insertion applied, which is the thing the action is judged on. */
function repaired(src: string, table: Table, audit: Table): string {
  let out = src;
  // Back to front, so an earlier edit does not move a later one's offset.
  for (const insertion of [...insertions(mysql, table, audit)].reverse()) {
    const text = insertion.columns.map((column) => `,\n  ${auditDefinition(column.definition)}`).join("");
    out = out.slice(0, insertion.after) + text + out.slice(insertion.after);
  }
  return out;
}

// ---------------------------------------------------------------- the convention

test("the twin's name is the table's with the prefix on it", () => {
  assert.equal(auditTableName("movements"), "aud_movements");
});

test("the audit prefix is however many leading columns the table does not have", () => {
  // Derived and not listed, which is what lets a schema name its bookkeeping columns anything.
  assert.equal(prefixCount(mysql, movements, twin), 2);
});

test("a twin that mirrors nothing is all prefix", () => {
  const unrelated = tableIn(`CREATE TABLE aud_movements (aud_id int, aud_at datetime);`, "aud_movements");
  assert.equal(prefixCount(mysql, movements, unrelated), 2);
});

// ------------------------------------------------------------ the missing columns

test("the columns the twin does not carry come back in the table's own order", () => {
  assert.deepEqual(
    missingColumns(mysql, movements, twin).map((column) => column.name),
    ["note"],
  );
});

test("a twin in step with its table is missing nothing", () => {
  assert.deepEqual(missingColumns(mysql, movements, tableIn(MOVEMENTS, "movements")), []);
});

test("case is not what tells two columns apart, here as everywhere else", () => {
  const shouting = tableIn(`CREATE TABLE aud_movements (aud_id int, MOVEMENT_ID int);`, "aud_movements");
  assert.deepEqual(
    missingColumns(mysql, movements, shouting).map((column) => column.name),
    ["account_id", "amount", "note"],
  );
});

// ---------------------------------------------------------------- the insertion

test("a column goes where the table has it and not at the end", () => {
  // The triggers insert positionally: appended after `amount`, `account_id` would be written into
  // the slot that holds the amount, which is worse than not auditing it at all.
  const src = `CREATE TABLE aud_movements (
  aud_id int NOT NULL,
  movement_id int NOT NULL,
  amount decimal(10,2) NOT NULL
);`;

  assert.equal(
    repaired(src, movements, tableIn(src, "aud_movements")),
    `CREATE TABLE aud_movements (
  aud_id int NOT NULL,
  movement_id int NOT NULL,
  account_id int NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(200) DEFAULT NULL
);`,
  );
});

test("the twin comes out with the missing column in the table's position", () => {
  assert.equal(
    repaired(TWIN, movements, twin),
    `CREATE TABLE aud_movements (
  aud_id int NOT NULL AUTO_INCREMENT,
  aud_at datetime NOT NULL,
  movement_id int NOT NULL,
  account_id int NOT NULL,
  amount decimal(10,2) NOT NULL,
  note varchar(200) DEFAULT NULL,
  PRIMARY KEY (aud_id)
);`,
  );
});

test("a column missing before every mirrored one still lands after the prefix", () => {
  const table = tableIn(`CREATE TABLE movements (leading int NOT NULL, movement_id int NOT NULL);`, "movements");
  const audit = tableIn(`CREATE TABLE aud_movements (
  aud_id int NOT NULL,
  movement_id int NOT NULL
);`, "aud_movements");

  assert.equal(
    repaired(
      `CREATE TABLE aud_movements (
  aud_id int NOT NULL,
  movement_id int NOT NULL
);`,
      table,
      audit,
    ),
    `CREATE TABLE aud_movements (
  aud_id int NOT NULL,
  leading int NOT NULL,
  movement_id int NOT NULL
);`,
  );
});

test("a twin with no prefix at all is left alone, because there is nowhere to anchor", () => {
  // Every one of its columns mirrors one of the table's, so a column missing before the first has
  // no definition to follow. Inventing a position inside the `CREATE TABLE`'s parenthesis is how a
  // generated edit ends up producing something that does not parse.
  const table = tableIn(`CREATE TABLE movements (leading int, movement_id int);`, "movements");
  const audit = tableIn(`CREATE TABLE aud_movements (movement_id int);`, "aud_movements");
  assert.deepEqual(insertions(mysql, table, audit), []);
});

test("the auto-increment is dropped, because MySQL allows the twin only its own", () => {
  assert.equal(auditDefinition("movement_id int NOT NULL AUTO_INCREMENT"), "movement_id int NOT NULL");
  assert.equal(auditDefinition("movement_id int NOT NULL auto_increment"), "movement_id int NOT NULL");
});

test("everything else is copied verbatim, drift included", () => {
  // A twin whose column is `DEFAULT NULL` where the table says `NOT NULL` is the normal state of a
  // real schema, and normalising it here would turn a repair into a rewrite of columns nobody asked
  // about.
  assert.equal(auditDefinition("note varchar(200) DEFAULT NULL"), "note varchar(200) DEFAULT NULL");
});

// ------------------------------------------------------------------ the triggers

/** The value list a trigger source ends up carrying once the rewrite is applied. */
function rewritten(src: string, table: Table, prefix: number): string {
  const lexed = tokenize(src);
  const trigger = parseDDL(mysql, src, lexed).triggers[0];
  assert.ok(trigger, "the source defines no trigger");

  let out = src;
  for (const insert of [...triggerInserts(mysql, lexed.tokens, trigger.body, table, "aud_movements", prefix)].reverse()) {
    out = out.slice(0, insert.s) + insert.text + out.slice(insert.e);
  }
  return out;
}

const TRIGGER = `CREATE TRIGGER movements_ai AFTER INSERT ON movements FOR EACH ROW
BEGIN
  INSERT INTO aud_movements VALUES (0, NOW(), NEW.movement_id, NEW.account_id, NEW.amount);
END;`;

test("the value list is rewritten to carry every column, in the table's order", () => {
  assert.match(
    rewritten(TRIGGER, movements, 2),
    /VALUES \(0, NOW\(\), NEW\.movement_id, NEW\.account_id, NEW\.amount, NEW\.note\)/,
  );
});

test("the prefix slots survive untouched, whatever they hold", () => {
  // They are `0`, a timestamp and a user, and they say nothing about the table's columns. A rewrite
  // that started at the first slot would throw the bookkeeping away.
  const src = TRIGGER.replace("0, NOW()", "0, NOW(), SUBSTRING_INDEX(USER(), '@', 1), 'I'");
  assert.match(rewritten(src, movements, 4), /VALUES \(0, NOW\(\), SUBSTRING_INDEX\(USER\(\), '@', 1\), 'I', NEW\./);
});

test("which of NEW or OLD to write is read off the slots being replaced", () => {
  // The `AFTER UPDATE` trigger writes one row of each, so it cannot be decided from the trigger.
  const src = TRIGGER.replace(/NEW\./g, "OLD.");
  const out = rewritten(src, movements, 2);
  assert.match(out, /VALUES \(0, NOW\(\), OLD\.movement_id, OLD\.account_id, OLD\.amount, OLD\.note\)/);
  assert.equal(out.includes("NEW."), false, "the rewrite came out with the wrong qualifier");
});

test("an insert into another table in the same body is not touched", () => {
  const src = TRIGGER.replace("aud_movements", "log_movements");
  assert.equal(rewritten(src, movements, 2), src);
});

test("an insert that names its columns is left alone rather than half-rewritten", () => {
  // Naming the columns is the form that cannot fall out of step, so there is nothing to repair —
  // and the slot the rewrite would start at holds a column name, not a `NEW.`.
  const src = TRIGGER.replace(
    "aud_movements VALUES",
    "aud_movements (aud_id, aud_at, movement_id, account_id, amount) VALUES",
  );
  assert.equal(rewritten(src, movements, 2), src);
});

test("a value list no longer than the prefix has nothing to rewrite", () => {
  assert.equal(rewritten(TRIGGER, movements, 9), TRIGGER);
});
