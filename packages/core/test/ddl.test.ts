/**
 * The parts of a parsed table that carry a decision rather than a reading of the SQL.
 *
 * Running the parser over real repos proves it survives what people actually write, but it
 * cannot state what a field is *supposed* to hold. These three can only be pinned down by
 * example: the schema qualifier, whether a name was written delimited, and the type taken apart
 * instead of kept as raw engine text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { mysql } from "../src/dialects/mysql/index.ts";
import type { Table } from "../src/model/table.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

function parse(src: string): ReturnType<typeof parseDDL> {
  return parseDDL(mysql, src, tokenize(src));
}

function oneTable(src: string): Table {
  const { tables } = parse(src);
  assert.equal(tables.length, 1);
  return tables[0]!;
}

test("takes the type apart, and keeps the text it was written as", () => {
  const table = oneTable(
    "CREATE TABLE t (\n" +
      "  `a` int unsigned NOT NULL,\n" +
      "  `b` decimal(10,2) NOT NULL,\n" +
      "  `c` enum('x','y') NOT NULL,\n" +
      "  `d` double precision NOT NULL,\n" +
      "  `e` int(11) unsigned zerofill NOT NULL\n" +
      ");",
  );

  const byName = (name: string) => table.byName.get(name)!;

  assert.deepEqual(byName("a").type, { name: "int", args: [], unsigned: true, raw: "int unsigned" });
  assert.deepEqual(byName("b").type, { name: "decimal", args: ["10", "2"], raw: "decimal(10,2)" });
  assert.deepEqual(byName("c").type, { name: "enum", args: ["'x'", "'y'"], raw: "enum('x','y')" });
  // `PRECISION` is a type suffix, so the raw text keeps both words even though the name is one.
  assert.deepEqual(byName("d").type, { name: "double", args: [], raw: "double precision" });
  assert.deepEqual(byName("e").type, {
    name: "int",
    args: ["11"],
    unsigned: true,
    zerofill: true,
    raw: "int(11) unsigned zerofill",
  });
});

test("keeps the schema qualifier apart from the name", () => {
  const table = oneTable("CREATE TABLE app_prod.users (`Id` int NOT NULL);");
  assert.equal(table.schema, "app_prod");
  assert.equal(table.name, "users");
  // The span points at the name, not at the schema: that is where goto-definition lands.
  assert.equal(table.name, "CREATE TABLE app_prod.users (`Id` int NOT NULL);".slice(table.nameSpan.s, table.nameSpan.e));

  const bare = oneTable("CREATE TABLE users (`Id` int NOT NULL);");
  assert.equal(bare.schema, undefined);
});

test("records whether each name was written delimited", () => {
  const table = oneTable("CREATE TABLE `order` (`Key` int NOT NULL, plain int NOT NULL);");
  assert.equal(table.quoted, true);
  assert.equal(table.byName.get("key")!.quoted, true);
  assert.equal(table.byName.get("plain")!.quoted, false);
});

test("indexes columns by the dialect's folding, not by the spelling", () => {
  const table = oneTable("CREATE TABLE t (`UserID` int NOT NULL);");
  assert.ok(table.byName.get("userid"));
  assert.equal(table.byName.get("UserID"), undefined);
});

test("a trigger carries its schema too", () => {
  const { triggers } = parse("CREATE TRIGGER db.t_ai AFTER INSERT ON db.orders FOR EACH ROW BEGIN END;");
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]!.schema, "db");
  assert.equal(triggers[0]!.name, "t_ai");
  assert.equal(triggers[0]!.table, "orders");
});

test("only text columns inherit the table's default collation", () => {
  const table = oneTable(
    "CREATE TABLE t (`a` int NOT NULL, `b` varchar(10) NOT NULL, `c` char(1) COLLATE utf8_bin NOT NULL)\n" +
      "  ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;",
  );
  assert.equal(table.collation, "utf8mb4_unicode_ci");
  assert.equal(table.byName.get("a")!.collation, undefined);
  assert.equal(table.byName.get("b")!.collation, "utf8mb4_unicode_ci");
  // Its own `COLLATE` wins over the table's.
  assert.equal(table.byName.get("c")!.collation, "utf8_bin");
});
