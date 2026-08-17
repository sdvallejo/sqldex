/**
 * The rules that read a `CREATE TABLE` or a `CREATE TRIGGER`.
 *
 * Every case is DDL, because that is what these rules take: the fixture and the subject are the
 * same text, so a case reads as the schema it is about. The catalog is built from the same DDL,
 * which is what lets a rule about *two* tables — an audit twin, a foreign key's target, the type
 * census — be written as one readable snippet.
 *
 * Each rule is exercised alone. Running the whole set would make every case depend on the
 * de-duplication order, and then a change to one rule would move another rule's expectations;
 * `registry.test.ts` owns the ordering questions.
 *
 * **Guard pairs.** Most of these rules are only usable because of a guard that silences a class of
 * true-but-useless finding. A guard is a hypothesis with no control unless something checks that it
 * did not also silence the case next door, so each one gets two cases: the one that must go quiet
 * and the neighbour that must still sound.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { columnTypeCensus } from "../src/catalog/catalog.ts";
import { defaults } from "../src/config/config.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Table } from "../src/model/table.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { Rule, RuleCatalog } from "../src/rules/rule.ts";
import {
  auditTableOutOfSync,
  auditTriggerMissingColumn,
  divergentType,
  fkMissingIndex,
  fkUnknownColumn,
  fkUnknownTable,
  indexUnknownColumn,
  noPrimaryKey,
  redundantIndex,
} from "../src/rules/index.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

/**
 * Runs one rule over `src`, with a catalog built from `schema` — which defaults to `src` itself,
 * since a table usually needs to be in the catalog to be talked about.
 */
function run(rule: Rule, src: string, schema = src): string[] {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, schema, tokenize(schema)).tables) {
    if (!table.temporary) tables.set(table.name.toLowerCase(), table);
  }
  const catalog: RuleCatalog = {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: () => undefined,
    columnTypes: () => columnTypeCensus(mysql, tables),
  };

  return check(
    new Registry().add(rule),
    { dialect: mysql, catalog, schemas: new Set(["shop"]), config: defaults },
    src,
  ).map((d) => d.message);
}

// ---------------------------------------------------------------- foreign keys

const FK_SCHEMA = [
  "CREATE TABLE customers (",
  "  customer_id int NOT NULL,",
  "  status char(1) NOT NULL,",
  "  PRIMARY KEY (customer_id)",
  ");",
].join("\n");

test("a foreign key pointing at a table that does not exist is an error", () => {
  const src = [
    FK_SCHEMA,
    "CREATE TABLE orders (",
    "  order_id int NOT NULL,",
    "  customer_id int NOT NULL,",
    "  CONSTRAINT fk_orders_customers FOREIGN KEY (customer_id) REFERENCES clints (customer_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkUnknownTable, src), [
    "foreign key fk_orders_customers points at an unknown table: clints",
  ]);
});

test("a key with no name still says which key it is, as best it can", () => {
  const src = [
    FK_SCHEMA,
    "CREATE TABLE orders (",
    "  customer_id int NOT NULL,",
    "  FOREIGN KEY (customer_id) REFERENCES clints (customer_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkUnknownTable, src), ["foreign key points at an unknown table: clints"]);
});

test("a reference into a schema the engine itself owns is not a dangling one", () => {
  const src = [
    "CREATE TABLE audit_log (",
    "  table_name varchar(64) NOT NULL,",
    "  CONSTRAINT fk_log FOREIGN KEY (table_name) REFERENCES information_schema (TABLE_NAME)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkUnknownTable, src), [], "those tables were never going to be in the repo");
});

test("a foreign key naming a column neither end has is an error, on both ends", () => {
  const src = [
    FK_SCHEMA,
    "CREATE TABLE orders (",
    "  order_id int NOT NULL,",
    "  customer_id int NOT NULL,",
    "  CONSTRAINT fk_a FOREIGN KEY (buyer_id) REFERENCES customers (customer_id),",
    "  CONSTRAINT fk_b FOREIGN KEY (customer_id) REFERENCES customers (client_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkUnknownColumn, src), [
    "orders has no column buyer_id",
    "customers has no column client_id",
  ]);
});

test("nothing is said about the target's columns when the target itself is missing", () => {
  const src = [
    FK_SCHEMA,
    "CREATE TABLE orders (",
    "  customer_id int NOT NULL,",
    "  CONSTRAINT fk_a FOREIGN KEY (customer_id) REFERENCES clints (whatever)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkUnknownColumn, src), [], "the other rule has the useful thing to say");
});

// -------------------------------------------------------- fk without an index

test("a foreign key no index on the target begins with is reported", () => {
  const src = [
    "CREATE TABLE registers (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  PRIMARY KEY (register_id, store_id),",
    "  KEY ix_store (store_id)",
    ");",
    "CREATE TABLE register_uses (",
    "  use_id int NOT NULL,",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  PRIMARY KEY (use_id),",
    "  CONSTRAINT fk_uses_registers FOREIGN KEY (register_id, store_id)",
    "    REFERENCES registers (store_id, register_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkMissingIndex, src), [
    "foreign key fk_uses_registers references registers (store_id, register_id): " +
      "PRIMARY KEY is (register_id, store_id), the other way round",
  ]);
});

test("the comparison is position by position, not set against set", () => {
  // The guard's whole point: the columns above are exactly the primary key's, in the other order.
  // A set comparison would call that covered, and it is the common version of the mistake.
  const src = [
    "CREATE TABLE registers (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  PRIMARY KEY (register_id, store_id)",
    ");",
    "CREATE TABLE register_uses (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  CONSTRAINT fk_ok FOREIGN KEY (register_id, store_id)",
    "    REFERENCES registers (register_id, store_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkMissingIndex, src), [], "the same order is covered by the same index");
});

test("no index at all over the pair reads differently from a reversed one", () => {
  const src = [
    "CREATE TABLE registers (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  PRIMARY KEY (register_id),",
    "  KEY ix_store (store_id)",
    ");",
    "CREATE TABLE register_uses (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  CONSTRAINT fk_pair FOREIGN KEY (register_id, store_id)",
    "    REFERENCES registers (store_id, register_id)",
    ");",
  ].join("\n");
  const [message] = run(fkMissingIndex, src);
  assert.match(message ?? "", /no index on registers starts with them/);
});

test("a prefix of a longer index covers the key", () => {
  const src = [
    "CREATE TABLE registers (",
    "  register_id int NOT NULL,",
    "  store_id int NOT NULL,",
    "  opened_at datetime NOT NULL,",
    "  PRIMARY KEY (register_id, store_id, opened_at)",
    ");",
    "CREATE TABLE register_uses (",
    "  register_id int NOT NULL,",
    "  CONSTRAINT fk_one FOREIGN KEY (register_id) REFERENCES registers (register_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkMissingIndex, src), [], "the index starts with it, which is all InnoDB needs");
});

test("it stands down when a referenced column does not exist", () => {
  const src = [
    "CREATE TABLE registers (register_id int NOT NULL, PRIMARY KEY (register_id));",
    "CREATE TABLE register_uses (",
    "  register_id int NOT NULL,",
    "  CONSTRAINT fk_bad FOREIGN KEY (register_id) REFERENCES registers (missing_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(fkMissingIndex, src), [], "the other rule says the useful thing");
});

// --------------------------------------------------------------------- indexes

test("an index or primary key over a column the table lacks is an error", () => {
  const src = [
    "CREATE TABLE shipments (",
    "  shipment_id int NOT NULL,",
    "  carrier varchar(40) NOT NULL,",
    "  PRIMARY KEY (shipmnt_id),",
    "  KEY ix_carrier (carrer)",
    ");",
  ].join("\n");
  assert.deepEqual(run(indexUnknownColumn, src), [
    "the primary key names shipmnt_id, which shipments does not have",
    "index ix_carrier names carrer, which shipments does not have",
  ]);
});

test("a partial index's length is a length, not a column", () => {
  const src = [
    "CREATE TABLE shipments (",
    "  shipment_id int NOT NULL,",
    "  payload text NOT NULL,",
    "  PRIMARY KEY (shipment_id),",
    "  KEY ix_payload (payload(10))",
    ");",
  ].join("\n");
  assert.deepEqual(run(indexUnknownColumn, src), []);
});

// ----------------------------------------------------------- redundant indexes

test("an index a longer one already begins with is redundant", () => {
  const src = [
    "CREATE TABLE payments (",
    "  payment_id int NOT NULL,",
    "  order_id int NOT NULL,",
    "  paid_at datetime NOT NULL,",
    "  PRIMARY KEY (payment_id),",
    "  KEY ix_order (order_id),",
    "  KEY ix_order_paid (order_id, paid_at)",
    ");",
  ].join("\n");
  assert.deepEqual(run(redundantIndex, src), [
    "ix_order (order_id) is redundant: ix_order_paid already begins with those columns",
  ]);
});

test("a UNIQUE prefix is not redundant, because it promises something the longer one does not", () => {
  // The exemption is the whole rule: without it, this reports and proposes dropping a constraint.
  const src = [
    "CREATE TABLE payments (",
    "  payment_id int NOT NULL,",
    "  order_id int NOT NULL,",
    "  paid_at datetime NOT NULL,",
    "  PRIMARY KEY (payment_id),",
    "  UNIQUE KEY ux_order (order_id),",
    "  KEY ix_order_paid (order_id, paid_at)",
    ");",
  ].join("\n");
  assert.deepEqual(run(redundantIndex, src), [], "unique on order_id alone is a different promise");
});

test("but a plain index covering the same columns as a unique one is pure cost", () => {
  const src = [
    "CREATE TABLE payments (",
    "  payment_id int NOT NULL,",
    "  order_id int NOT NULL,",
    "  PRIMARY KEY (payment_id),",
    "  UNIQUE KEY ux_order (order_id),",
    "  KEY ix_order (order_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(redundantIndex, src), [
    "ix_order (order_id) is redundant: ux_order already begins with those columns",
  ]);
});

test("the primary key covers others but is never itself the redundant one", () => {
  const src = [
    "CREATE TABLE payments (",
    "  order_id int NOT NULL,",
    "  paid_at datetime NOT NULL,",
    "  PRIMARY KEY (order_id, paid_at),",
    "  KEY ix_order (order_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(redundantIndex, src), [
    "ix_order (order_id) is redundant: the primary key already begins with those columns",
  ]);
});

test("two identical indexes are reported once, on the later of them", () => {
  const src = [
    "CREATE TABLE payments (",
    "  payment_id int NOT NULL,",
    "  order_id int NOT NULL,",
    "  PRIMARY KEY (payment_id),",
    "  KEY ix_a (order_id),",
    "  KEY ix_b (order_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(redundantIndex, src), [
    "ix_b (order_id) is redundant: ix_a already begins with those columns",
  ]);
});

// ------------------------------------------------------------- divergent types

/** Five tables agreeing on `char(1)`, which is the majority an outlier stands out from. */
const AGREEING = [1, 2, 3, 4, 5]
  .map((n) => `CREATE TABLE flags${n} (id int NOT NULL, marker char(1) NOT NULL, PRIMARY KEY (id));`)
  .join("\n");

test("one table typing a shared column differently from the rest is an outlier", () => {
  const odd = "CREATE TABLE flags_odd (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, odd, `${AGREEING}\n${odd}`), [
    "marker is varchar(50) here and char(1) in 5 of the 6 tables that have it",
  ]);
});

test("a column name too rarely used has no majority to be in the minority of", () => {
  const few = [
    "CREATE TABLE flags1 (id int NOT NULL, marker char(1) NOT NULL, PRIMARY KEY (id));",
    "CREATE TABLE flags_odd (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));",
  ].join("\n");
  const odd = "CREATE TABLE flags_odd (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, odd, few), [], "two uses is not a convention to break");
});

test("a rival used more than twice is a second convention, not a slip", () => {
  const rivals = [
    AGREEING,
    "CREATE TABLE flags_x (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));",
    "CREATE TABLE flags_y (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));",
    "CREATE TABLE flags_z (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));",
  ].join("\n");
  const odd = "CREATE TABLE flags_x (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, odd, rivals), []);
});

test("the display width is normalised away, so int(11) and int are one type", () => {
  const widths = [
    [1, 2, 3, 4, 5]
      .map((n) => `CREATE TABLE nums${n} (id int NOT NULL, amount int NOT NULL, PRIMARY KEY (id));`)
      .join("\n"),
    "CREATE TABLE nums_odd (id int NOT NULL, amount int(11) NOT NULL, PRIMARY KEY (id));",
  ].join("\n");
  const odd = "CREATE TABLE nums_odd (id int NOT NULL, amount int(11) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, odd, widths), [], "the same type written two ways");
});

test("an aud_ twin is neither counted nor judged", () => {
  const twin = "CREATE TABLE aud_flags (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, twin, `${AGREEING}\n${twin}`), [], "a copy is not evidence");
});

test("a *Mig copy is left out the same way, being frozen history", () => {
  const mig = "CREATE TABLE flags_mig (id int NOT NULL, marker varchar(50) NOT NULL, PRIMARY KEY (id));";
  assert.deepEqual(run(divergentType, mig, `${AGREEING}\n${mig}`), []);
});

// -------------------------------------------------------------- primary keys

test("a table with no primary key is a hint", () => {
  const src = "CREATE TABLE tmp_report (order_id int NOT NULL, total decimal(10,2) NOT NULL);";
  assert.deepEqual(run(noPrimaryKey, src), ["tmp_report has no primary key"]);
});

test("a temporary table is never asked for one", () => {
  const src = "CREATE TEMPORARY TABLE tmp_result (order_id int NOT NULL);";
  assert.deepEqual(run(noPrimaryKey, src), [], "it lasts one procedure");
});

// -------------------------------------------------------------------- audit

const AUDITED = [
  "CREATE TABLE members (",
  "  member_id int NOT NULL,",
  "  status char(1) NOT NULL,",
  "  joined_at datetime NOT NULL,",
  "  PRIMARY KEY (member_id)",
  ");",
].join("\n");

test("a column the aud_ twin does not have is reported, on the column", () => {
  const twin = [
    "CREATE TABLE aud_members (",
    "  aud_id int NOT NULL,",
    "  changed_at datetime NOT NULL,",
    "  member_id int NOT NULL,",
    "  status char(1) NOT NULL,",
    "  PRIMARY KEY (aud_id)",
    ");",
  ].join("\n");
  assert.deepEqual(run(auditTableOutOfSync, AUDITED, `${AUDITED}\n${twin}`), [
    "audit table aud_members has no column joined_at",
  ]);
});

test("no aud_ twin means the convention is not in use, and nothing is said", () => {
  assert.deepEqual(run(auditTableOutOfSync, AUDITED), []);
});

test("a generated column is still expected in the twin", () => {
  const table = [
    "CREATE TABLE members (",
    "  member_id int NOT NULL,",
    "  full_name varchar(80) AS (CONCAT(member_id, '')) STORED,",
    "  PRIMARY KEY (member_id)",
    ");",
  ].join("\n");
  const twin = "CREATE TABLE aud_members (aud_id int NOT NULL, member_id int NOT NULL, PRIMARY KEY (aud_id));";
  assert.deepEqual(run(auditTableOutOfSync, table, `${table}\n${twin}`), [
    "audit table aud_members has no column full_name",
  ]);
});

test("an audit trigger that skips a column says which, once, on the trigger", () => {
  const trigger = [
    "CREATE TRIGGER members_ai AFTER INSERT ON members FOR EACH ROW BEGIN",
    "  INSERT INTO aud_members VALUES (0, NOW(), NEW.member_id, NEW.status);",
    "END;",
  ].join("\n");
  assert.deepEqual(run(auditTriggerMissingColumn, trigger, `${AUDITED}\n${trigger}`), [
    "members_ai does not audit joined_at",
  ]);
});

test("NEW and OLD both count as auditing a column", () => {
  const trigger = [
    "CREATE TRIGGER members_au AFTER UPDATE ON members FOR EACH ROW BEGIN",
    "  INSERT INTO aud_members VALUES (0, NOW(), OLD.member_id, OLD.status, OLD.joined_at);",
    "  INSERT INTO aud_members VALUES (0, NOW(), NEW.member_id, NEW.status, NEW.joined_at);",
    "END;",
  ].join("\n");
  assert.deepEqual(run(auditTriggerMissingColumn, trigger, `${AUDITED}\n${trigger}`), []);
});

test("a trigger that does not write to the aud_ table is not an audit trigger", () => {
  // Without this guard the rule reads as "every trigger must mention every column", which is
  // nonsense for a trigger enforcing a business rule.
  const trigger = [
    "CREATE TRIGGER members_bi BEFORE INSERT ON members FOR EACH ROW BEGIN",
    "  IF NEW.status = 'X' THEN SET NEW.status = 'A'; END IF;",
    "END;",
  ].join("\n");
  assert.deepEqual(run(auditTriggerMissingColumn, trigger, `${AUDITED}\n${trigger}`), []);
});

test("a trigger on a table the catalog does not have is not judged", () => {
  const trigger = [
    "CREATE TRIGGER ghost_ai AFTER INSERT ON ghosts FOR EACH ROW BEGIN",
    "  INSERT INTO aud_ghosts VALUES (0, NOW());",
    "END;",
  ].join("\n");
  assert.deepEqual(run(auditTriggerMissingColumn, trigger, trigger), []);
});
