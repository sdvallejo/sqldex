/**
 * The rule engine, tested with rules invented for the purpose.
 *
 * These cases are about the engine's policies — which subject a rule is handed, how many times,
 * what the cap and the de-duplication and the suppression comments do, and how a severity is
 * resolved against a config — and none of that is easier to see through a real rule. A rule that
 * reports every identifier it is given makes the traversal visible; `query/unfiltered-write` would
 * only make it arguable.
 *
 * Whether each real rule finds what it claims to find is a separate question, and its own file
 * owns it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaults } from "../src/config/config.ts";
import type { Config } from "../src/config/config.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import { mysql } from "../src/dialects/mysql/index.ts";
import type { Table } from "../src/model/table.ts";
import { allRules } from "../src/rules/index.ts";
import { check, Registry } from "../src/rules/registry.ts";
import type { DocumentContext, Rule, RuleCatalog } from "../src/rules/rule.ts";
import { parseDDL } from "../src/syntax/fast/ddl.ts";
import { tokenize } from "../src/syntax/fast/lexer.ts";

/** A catalog holding exactly what a case needs. */
function catalogOf(ddl = ""): RuleCatalog {
  const tables = new Map<string, Table>();
  for (const table of parseDDL(mysql, ddl, tokenize(ddl)).tables) {
    tables.set(table.name.toLowerCase(), table);
  }
  return {
    table: (name) => (name === undefined ? undefined : tables.get(name.toLowerCase())),
    routine: () => undefined,
    trigger: () => undefined,
    tempTable: () => undefined,
    tables,
    index: (_key, build) => build(tables),
  };
}

function configWith(diagnostics: Partial<Config["diagnostics"]> = {}): Config {
  return { ...defaults, diagnostics: { ...defaults.diagnostics, ...diagnostics } };
}

function run(rules: Rule[], src: string, config = configWith(), ddl = ""): Diagnostic[] {
  const registry = new Registry().add(...rules);
  return check(
    registry,
    { dialect: mysql, catalog: catalogOf(ddl), schemas: new Set(["shop"]), config },
    src,
  );
}

/** Reports once per subject it is handed, so the count is the number of traversals. */
function counter(id: string, scope: Rule["scope"]): Rule {
  const rule = {
    id,
    // The registry insists the prefix and the group agree, so it is read off the id here rather
    // than passed separately — which is the whole point of that check.
    group: id.slice(0, id.indexOf("/")) as Rule["group"],
    severity: "warn",
    docs: "counts how often the engine hands it a subject",
    scope,
  } as const;
  switch (scope) {
    case "document":
      return { ...rule, scope, check: (ctx) => ctx.report({ s: 0, e: 1 }, "document") };
    case "statement":
      return {
        ...rule,
        scope,
        check: (ctx) => ctx.report({ s: ctx.tokens[ctx.statement.from]!.s, e: 1 }, "statement"),
      };
    case "routine":
      return { ...rule, scope, check: (ctx) => ctx.report(ctx.routine.nameSpan, ctx.routine.name) };
    case "table":
      return { ...rule, scope, check: (ctx) => ctx.report(ctx.table.nameSpan, ctx.table.name) };
    case "trigger":
      return { ...rule, scope, check: (ctx) => ctx.report(ctx.trigger.nameSpan, ctx.trigger.name) };
  }
}

test("a document rule sees the file once, whatever is in it", () => {
  const found = run([counter("names/doc", "document")], "SELECT 1; SELECT 2; SELECT 3;");
  assert.equal(found.length, 1);
});

test("a statement rule sees each statement, and never a DDL one", () => {
  const src = "SELECT 1;\nCREATE TABLE t (id int);\nUPDATE orders SET total = 0;\nDROP TABLE t;";
  const found = run([counter("names/stmt", "statement")], src);
  assert.equal(found.length, 2, "the SELECT and the UPDATE; not the CREATE, not the DROP");
});

test("a table rule sees each real table, and skips the temporary ones", () => {
  const src =
    "CREATE TABLE orders (id int);\n" +
    "CREATE TEMPORARY TABLE tmp_result (id int);\n" +
    "CREATE TABLE customers (id int);";
  const found = run([counter("names/table", "table")], src);
  assert.deepEqual(
    found.map((d) => d.message),
    ["orders", "customers"],
    "a temporary table is not part of the schema",
  );
});

test("a trigger rule sees each trigger", () => {
  const src =
    "CREATE TABLE orders (id int);\n" +
    "CREATE TRIGGER orders_ai AFTER INSERT ON orders FOR EACH ROW BEGIN SET @x = 1; END;\n" +
    "CREATE TRIGGER orders_au AFTER UPDATE ON orders FOR EACH ROW BEGIN SET @x = 2; END;";
  const found = run([counter("names/trigger", "trigger")], src);
  assert.deepEqual(
    found.map((d) => d.message),
    ["orders_ai", "orders_au"],
  );
});

test("the diagnostic carries the rule's id as its code", () => {
  const found = run([counter("schema/whatever", "document")], "SELECT 1");
  assert.equal(found[0]?.code, "schema/whatever");
});

test("the statement context finds the calls, inserts and qualified names in one pass", () => {
  const seen: string[] = [];
  const spy: Rule = {
    id: "names/spy",
    group: "names",
    severity: "warn",
    scope: "statement",
    docs: "records what the engine collected",
    check: (ctx) => {
      for (const i of ctx.calls) seen.push(`call:${ctx.tokens[i + 1]?.v}`);
      for (const i of ctx.inserts) seen.push(`insert:${ctx.tokens[i + 2]?.v}`);
      for (const i of ctx.qualified) seen.push(`dot:${ctx.tokens[i - 1]?.v}.${ctx.tokens[i + 1]?.v}`);
    },
  };
  run([spy], "SELECT o.total FROM orders o;\nCALL recalc(1);\nINSERT INTO orders (id) VALUES (1);");
  assert.deepEqual(seen, ["dot:o.total", "call:recalc", "insert:orders"]);
});

test("the relations of a statement arrive resolved, and aliases shadow table names", () => {
  const ddl = "CREATE TABLE orders (id int, total decimal(10,2));";
  const seen: string[] = [];
  const spy: Rule = {
    id: "names/spy",
    group: "names",
    severity: "warn",
    scope: "statement",
    docs: "records what resolved",
    check: (ctx) => {
      seen.push(...ctx.resolved.map((t) => t.name));
      seen.push(...[...ctx.byAlias.keys()].map((k) => `alias:${k}`));
    },
  };
  run([spy], "SELECT o.total FROM orders o", configWith(), ddl);
  assert.deepEqual(seen, ["orders", "alias:orders", "alias:o"]);
});

test("two rules on one token both speak, unless one says it displaces the other", () => {
  // The engine used to keep whichever rule was registered first, which made `rules/index.ts` order
  // load-bearing and silent: two rules on one token often say two different things, and one of them
  // disappeared with no way to know it had.
  const at = { s: 7, e: 12 };
  const vague: Rule = {
    id: "names/vague",
    group: "names",
    severity: "warn",
    scope: "document",
    docs: "claims the token",
    check: (ctx) => ctx.report(at, "the vague thing"),
  };
  const specific: Rule = {
    ...vague,
    id: "names/specific",
    check: (ctx: DocumentContext) => ctx.report(at, "the specific thing"),
  };

  const both = run([vague, specific], "SELECT total FROM orders");
  assert.deepEqual(both.map((d) => d.code).sort(), ["names/specific", "names/vague"]);

  // The claim lives on the rule that makes it, and holds whichever order they went in.
  const displacing: Rule = { ...specific, supersedes: ["names/vague"] };
  for (const order of [
    [vague, displacing],
    [displacing, vague],
  ]) {
    const found = run(order, "SELECT total FROM orders");
    assert.deepEqual(
      found.map((d) => d.code),
      ["names/specific"],
      "what decides is the declaration, not the position",
    );
  }
});

test("a rule may name a superseded rule that is not in this registry", () => {
  // Running one rule on its own is the ordinary thing to do — every rule test here does it — so a
  // name that is not registered simply never collides.
  const lonely: Rule = {
    id: "names/lonely",
    group: "names",
    severity: "warn",
    scope: "document",
    docs: "supersedes something that is not here",
    supersedes: ["names/absent"],
    check: (ctx) => ctx.report({ s: 7, e: 12 }, "still reported"),
  };
  assert.equal(run([lonely], "SELECT total FROM orders").length, 1);
});

test("every rule sqldex ships supersedes a rule that exists", () => {
  // The typo protection the registry deliberately does not enforce: a `supersedes` naming a rule
  // that is not shipped would silence nothing and say nothing, forever.
  const registry = allRules();
  for (const rule of registry.inOrder()) {
    for (const superseded of rule.supersedes ?? []) {
      assert.ok(registry.get(superseded), `${rule.id} supersedes ${superseded}, which does not exist`);
    }
  }
});

test("a file over the cap keeps the cap's worth and says how many it left out", () => {
  const flood: Rule = {
    id: "names/flood",
    group: "names",
    severity: "warn",
    scope: "document",
    docs: "reports on every token",
    // Distinct offsets, so it is the cap and not the collision resolution doing the work.
    check: (ctx) => ctx.tokens.forEach((t) => ctx.report(t, "again")),
  };
  const src = `SELECT ${Array.from({ length: 300 }, (_, i) => `c${i}`).join(", ")} FROM orders`;

  const found = run([flood], src);
  assert.equal(found.length, 101, "the cap, plus the note that says it was reached");
  assert.equal(found.at(-1)?.code, "sqldex:capped");
  assert.match(found.at(-1)?.message ?? "", /more findings in this file are not shown/);
});

test("what the cap drops is chosen by severity, so an error is never lost to a hint", () => {
  // The old cap cut the tail as the list was built: a hint found early kept its place and an error
  // found later fell off, which is the file that most needs reading losing what most needed saying.
  const noise: Rule = {
    id: "names/noise",
    group: "names",
    severity: "hint",
    scope: "document",
    docs: "reports on every token",
    check: (ctx) => ctx.tokens.forEach((t) => ctx.report(t, "noise")),
  };
  const serious: Rule = {
    ...noise,
    id: "names/serious",
    severity: "error",
    // One report, on the last token, so arrival order would have thrown it away.
    check: (ctx: DocumentContext) => {
      const last = ctx.tokens.at(-1);
      if (last) ctx.report(last, "the thing that matters");
    },
  };

  const src = `SELECT ${Array.from({ length: 300 }, (_, i) => `c${i}`).join(", ")} FROM orders`;
  const found = run([noise, serious], src);
  assert.ok(
    found.some((d) => d.code === "names/serious"),
    "the error survives a flood of hints",
  );
  // And it comes back where it was found, not first: severity chooses, position reads.
  assert.equal(found.at(-2)?.code, "names/serious");
});

test("`-- sqldex:ignore` silences the line after it, and nothing else", () => {
  const everyId: Rule = {
    id: "names/every-id",
    group: "names",
    severity: "warn",
    scope: "document",
    docs: "reports every identifier",
    check: (ctx) => ctx.tokens.filter((t) => t.t === "id").forEach((t) => ctx.report(t, t.v)),
  };
  // Keywords lex as identifiers here, so `SELECT` is reported too — which is fine: what this case
  // is about is which *line* went quiet.
  const src = ["SELECT alpha", "-- sqldex:ignore", "  , beta", "  , gamma"].join("\n");
  const found = run([everyId], src).map((d) => d.message);
  assert.ok(!found.includes("beta"), "the line after the comment is silent");
  assert.deepEqual(found, ["SELECT", "alpha", "gamma"]);
});

test("`-- sqldex:ignore <id>` silences that rule only, and a group name silences its rules", () => {
  const mkRule = (id: string, group: Rule["group"]): Rule => ({
    id,
    group,
    severity: "warn",
    scope: "document",
    docs: "reports every identifier",
    check: (ctx) => ctx.tokens.filter((t) => t.t === "id").forEach((t) => ctx.report(t, `${id}:${t.v}`)),
  });
  const rules = [mkRule("names/one", "names"), mkRule("audit/two", "audit")];

  const byId = ["SELECT alpha", "-- sqldex:ignore names/one", "  , beta"].join("\n");
  assert.deepEqual(
    run(rules, byId).map((d) => d.message).sort(),
    ["audit/two:SELECT", "audit/two:alpha", "audit/two:beta", "names/one:SELECT", "names/one:alpha"].sort(),
    "the other rule still reports the line this one was silenced on",
  );

  const byGroup = ["SELECT alpha", "-- sqldex:ignore audit", "  , beta"].join("\n");
  assert.deepEqual(
    run(rules, byGroup).map((d) => d.message).sort(),
    ["audit/two:SELECT", "audit/two:alpha", "names/one:SELECT", "names/one:alpha", "names/one:beta"].sort(),
    "silencing a group changes nothing for the rule that is not in it",
  );
});

test("`-- sqldex:ignore-file` silences the whole file, wherever it appears", () => {
  const src = "SELECT alpha\n-- sqldex:ignore-file\nFROM orders";
  assert.deepEqual(run([counter("names/doc", "document")], src), []);
});

test("a file that builds SQL as a string is skipped whole", () => {
  const src = "SET @s = CONCAT('SELECT * FROM ', tbl); PREPARE st FROM @s; EXECUTE st;";
  assert.deepEqual(run([counter("names/doc", "document")], src), [], "nothing here is knowable");
});

test("severity comes from the rule, then its group, then the rule's id", () => {
  const rule = counter("audit/thing", "document");
  assert.equal(run([rule], "SELECT 1")[0]?.severity, "warn", "the rule's own default");

  const byGroup = configWith({ groups: { audit: "hint" } });
  assert.equal(run([rule], "SELECT 1", byGroup)[0]?.severity, "hint");

  const byId = configWith({ groups: { audit: "hint" }, rules: { "audit/thing": "error" } });
  assert.equal(run([rule], "SELECT 1", byId)[0]?.severity, "error", "the id wins over the group");
});

test("`off` silences, at either granularity", () => {
  const rule = counter("audit/thing", "document");
  assert.deepEqual(run([rule], "SELECT 1", configWith({ groups: { audit: "off" } })), []);
  assert.deepEqual(run([rule], "SELECT 1", configWith({ rules: { "audit/thing": "off" } })), []);

  const rescued = configWith({ groups: { audit: "off" }, rules: { "audit/thing": "warn" } });
  assert.equal(run([rule], "SELECT 1", rescued).length, 1, "the id turns one back on");
});

test("a rule for another dialect does not run", () => {
  const rule: Rule = { ...counter("query/pg-only", "document"), dialects: ["postgres"] as never };
  assert.deepEqual(run([rule], "SELECT 1"), []);
});

test("nothing is parsed when every rule is off", () => {
  let ran = false;
  const rule: Rule = {
    ...counter("names/doc", "document"),
    check: () => {
      ran = true;
    },
  };
  run([rule], "SELECT 1", configWith({ rules: { "names/doc": "off" } }));
  assert.equal(ran, false);
});

test("registering the same id twice is a bug, not a silent replacement", () => {
  const registry = new Registry();
  registry.add(counter("names/doc", "document"));
  assert.throws(() => registry.add(counter("names/doc", "document")), /duplicate rule id/);
});

test("rules run in registration order, and are listed sorted", () => {
  const registry = new Registry().add(
    counter("query/b", "document"),
    counter("audit/a", "document"),
    counter("names/c", "document"),
  );
  assert.deepEqual(
    registry.inOrder().map((r) => r.id),
    ["query/b", "audit/a", "names/c"],
    "running order is declared, because the de-duplication depends on it",
  );
  assert.deepEqual(
    registry.all().map((r) => r.id),
    ["audit/a", "names/c", "query/b"],
    "listing order is alphabetical, because that is for a person to read",
  );
});

test("an id whose prefix is not its group is refused", () => {
  const mismatched = { ...counter("audit/thing", "document"), group: "names" } as Rule;
  assert.throws(() => new Registry().add(mismatched), /disagrees with its group/);
  assert.throws(() => new Registry().add(counter("NotAnId", "document")), /group\/kebab-case/);
});
