/**
 * Layout autodetection and what declares a DDL project.
 *
 * Every case builds a throwaway repo, because the question is always about directories on disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";

import {
  DECLARES_PROJECT,
  detectSources,
  detectTargets,
  isDdlProject,
  resolveProject,
  sourceFiles,
  targetFiles,
} from "../src/catalog/project.ts";
import { CONFIG_FILES, defaults, get, invalidate, schemas } from "../src/config/config.ts";

after(() => invalidate());

/** Builds a throwaway repo with the given directories and files. */
function makeRepo(layout: readonly string[], files: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "sqldex-project-"));
  for (const dir of layout) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  invalidate();
  return root;
}

/** The globs autodetection produced, which is the shape worth comparing. */
const globs = (root: string): string[] => detectSources(root).map((source) => source.glob);

test("recognises a Spanish-named layout", () => {
  const root = makeRepo(["tablas", "sp", "carga-valores"]);
  assert.deepEqual(globs(root), ["tablas/*.sql", "sp/*.sql", "carga-valores/*.sql", "**/*.sql"]);
  assert.equal(isDdlProject(root), true);
});

test("recognises an English-named one", () => {
  const root = makeRepo(["tables", "sps", "functions", "triggers", "seeds"]);
  assert.deepEqual(globs(root), [
    "tables/*.sql",
    "triggers/*.sql",
    "sps/*.sql",
    "functions/*.sql",
    "seeds/*.sql",
    "**/*.sql",
  ]);
  assert.equal(isDdlProject(root), true);
});

test("takes `procedures` as the routines directory it plainly is", () => {
  const root = makeRepo(["tables", "procedures", "triggers", "seeds"]);
  assert.deepEqual(globs(root), [
    "tables/*.sql",
    "triggers/*.sql",
    "procedures/*.sql",
    "seeds/*.sql",
    "**/*.sql",
  ]);
  // …and does it without reading a file, which is the only reason the name is listed at all.
  assert.equal(isDdlProject(root), true);
});

test("leaves the deploy scripts out of the catalog and into the lint targets", () => {
  const root = makeRepo(["tables", "sps", "deploy_folder"]);
  assert.deepEqual(globs(root), ["tables/*.sql", "sps/*.sql", "**/*.sql"]);
  assert.deepEqual(detectTargets(root, detectSources(root)).map((s) => s.glob), [
    "tables/*.sql",
    "sps/*.sql",
    "**/*.sql",
    "deploy_folder/**/*.sql",
  ]);
});

test("and the sweep does not smuggle the deploy scripts back into the catalog", () => {
  // The globs above both end in `**\/*.sql`, so only the files answer this one.
  const root = makeRepo(["tables", "sps"], ["tables/orders.sql", "deploy_folder/prod/001.sql"]);
  assert.deepEqual(sourceFiles(root).map((f) => basename(f.path)), ["orders.sql"]);
  assert.deepEqual(targetFiles(root).map((f) => basename(f.path)).sort(), ["001.sql", "orders.sql"]);
});

test("sweeps the whole tree when it recognises nothing", () => {
  const root = makeRepo([], ["schema.sql"]);
  assert.deepEqual(globs(root), ["**/*.sql"]);
});

test("takes `tablas` or `sp` on their own: nothing else is called that", () => {
  assert.equal(isDdlProject(makeRepo(["tablas"])), true);
  assert.equal(isDdlProject(makeRepo(["sp"])), true);
});

test("wants a routines directory next to `tables`, which any repo might have", () => {
  assert.equal(isDdlProject(makeRepo(["tables"])), false);
  assert.equal(isDdlProject(makeRepo(["tables", "sps"])), true);
  assert.equal(isDdlProject(makeRepo(["tables", "functions"])), true);
});

test("takes a config file as the declaration it is", () => {
  // A directory named nothing recognisable is a DDL project if the repo says so.
  assert.equal(isDdlProject(makeRepo(["esquema"], [".sqldex.json"])), true);
});

test("says no to a repo that merely contains a .sql", () => {
  const root = makeRepo(["src"], ["src/report.sql"]);
  writeFileSync(join(root, "src", "report.sql"), "SELECT id FROM orders;\n");
  assert.equal(isDdlProject(root), false);
});

test("says yes to a repo whose .sql files create something, whatever the directories are called", () => {
  // The case the marker list could not express: a layout nobody thought to name. Reading one file
  // answers it, and the alternative — deciding no — is a schema project that never says a word.
  const tables = makeRepo(["esquema"], ["esquema/orders.sql"]);
  writeFileSync(join(tables, "esquema", "orders.sql"), "CREATE TABLE orders (id INT);\n");
  assert.equal(isDdlProject(tables), true);

  // A repo of nothing but routines is one too, which is why the test is wider than `mightHoldTable`.
  const routines = makeRepo(["rutinas"], ["rutinas/settle.sql"]);
  writeFileSync(
    join(routines, "rutinas", "settle.sql"),
    "CREATE DEFINER=`app`@`%` PROCEDURE sp_settle_orders() BEGIN SELECT 1; END\n",
  );
  assert.equal(isDdlProject(routines), true);
});

test("a repo of statements that change a schema without declaring one is not a project", () => {
  // The distinction the guard is actually drawing: a catalog is built out of declarations, and a
  // directory of migrations has none to give it.
  const root = makeRepo(["migrations"], ["migrations/001.sql"]);
  writeFileSync(
    join(root, "migrations", "001.sql"),
    "CREATE INDEX idx_orders_customer ON orders (customer_id);\nCREATE USER 'app'@'%';\n",
  );
  assert.equal(isDdlProject(root), false);
});

test("does not go looking for a schema inside node_modules", () => {
  const root = makeRepo(["node_modules/pkg"], ["node_modules/pkg/orders.sql"]);
  writeFileSync(join(root, "node_modules", "pkg", "orders.sql"), "CREATE TABLE orders (id INT);\n");
  assert.equal(isDdlProject(root), false);
});

test("a half-recognised layout is catalogued in full", () => {
  // The regression this sweep exists for. `tables/` and `triggers/` matched, the routines sat
  // under a name not in the list, and the catalog came out silently missing every one of them —
  // while a repo matching nothing at all fell through to the sweep and came out right.
  const root = makeRepo(["tables", "triggers", "rutinas"], ["tables/orders.sql", "rutinas/settle.sql"]);
  assert.deepEqual(sourceFiles(root).map((f) => basename(f.path)).sort(), ["orders.sql", "settle.sql"]);
  // The typed source still wins the `kind`: the sweep only picks up what nobody claimed.
  assert.equal(sourceFiles(root).find((f) => basename(f.path) === "orders.sql")!.kind, "tables");
  assert.equal(sourceFiles(root).find((f) => basename(f.path) === "settle.sql")!.kind, "auto");
});

test("resolves the root from inside one of the project's own directories", () => {
  const root = makeRepo(["tablas", "sp"]);
  assert.equal(resolveProject(join(root, "tablas")), root);
  // …and from a file in it, which is how an editor asks.
  writeFileSync(join(root, "tablas", "T.sql"), "");
  assert.equal(resolveProject(join(root, "tablas", "T.sql")), root);
});

test("schemas default to the root's directory name, which is what these repos are called", () => {
  const root = makeRepo(["tables", "sps"]);
  assert.deepEqual([...schemas(root)], [basename(root).toLowerCase()]);
});

test("the project file overrides the schemas", () => {
  for (const name of CONFIG_FILES) {
    const root = makeRepo(["tables", "sps"]);
    writeFileSync(join(root, name), '{ "schemas": ["app_prod", "app_aud"] }');
    invalidate();
    assert.deepEqual([...schemas(root)].sort(), ["app_aud", "app_prod"]);
  }
});

test("the project file wins over the options, which win over the defaults", () => {
  const root = makeRepo(["tables", "sps"]);
  writeFileSync(join(root, ".sqldex.json"), '{ "diagnostics": { "groups": { "audit": "off" } } }');
  invalidate();

  const config = get(root, {
    diagnostics: { enabled: true, groups: { audit: "warn", query: "off" }, rules: {} },
  });
  assert.equal(config.diagnostics.groups.audit, "off", "the project file describes this one repo");
  assert.equal(config.diagnostics.groups.query, "off", "the options still apply where it is silent");
  assert.equal(config.diagnostics.enabled, true, "and they reach keys the project file omits");
  assert.deepEqual(config.diagnostics.rules, {}, "and the defaults where both are silent");
});

test("diagnostics are on unless a project says otherwise", () => {
  // The one key that only the editor reads. It is on by default because the alternative — a server
  // that starts, indexes everything and then says nothing — reads as broken rather than as quiet.
  assert.equal(defaults.diagnostics.enabled, true);

  const root = makeRepo(["tables", "sps"]);
  writeFileSync(join(root, ".sqldex.json"), '{ "diagnostics": { "enabled": false } }');
  invalidate();
  assert.equal(get(root).diagnostics.enabled, false);
});

test("invalid JSON is reported and treated as absent, rather than refusing to start", () => {
  const root = makeRepo(["tables", "sps"]);
  writeFileSync(join(root, ".sqldex.json"), "{ not json");
  invalidate();

  const warnings: string[] = [];
  const config = get(root, undefined, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.deepEqual(config.exclude, ["deploy.sql", "rollback.sql"]);
});

/**
 * The editor client keeps its own list of what declares a project, because a client has to decide
 * whether to start a server before there is one to ask. That list is a copy of the decision this
 * module owns, and a copy is the thing that goes quietly wrong: nothing fails when the two drift,
 * the client just attaches somewhere the engine then refuses to index.
 *
 * The list is read out of the client rather than duplicated a third time here, so this fails when
 * the copy moves rather than when it is wrong in some way this file happened to predict.
 */
test("the editor client starts wherever the engine would build a catalog", () => {
  const client = join(import.meta.dirname, "..", "..", "..", "editors/nvim/lsp/sqldex.lua");
  const block = /local MARKERS = \{([\s\S]*?)\n\}/.exec(readFileSync(client, "utf8"))?.[1];
  assert.ok(block, "the client's markers are no longer where this test looks for them");
  const markers = [...block.matchAll(/"([^"]+)"/g)].map((quoted) => quoted[1]!);

  // The direction is the whole assertion. A client looser than the engine costs a server that
  // starts and writes one line in its log; a client stricter than it costs a schema project that
  // never produces a diagnostic and never says why, which is the failure this pair used to have.
  for (const name of CONFIG_FILES) {
    assert.ok(markers.includes(name), `a repo declared by ${name} would not start a client`);
  }
  for (const combination of DECLARES_PROJECT) {
    assert.ok(
      combination.some((dir) => markers.includes(dir)),
      `the engine calls ${combination.join(" + ")} a project and the client would not start there`,
    );
  }

  // And the case no list of names can express: the engine reads the files, so the client has to
  // fall back to the same last resort the engine's own root search does.
  assert.ok(markers.includes(".git"), "nothing in the client catches a project the layout names miss");
  assert.ok(defaults.root_markers.includes(".git"), "…and no root would be found for it anyway");
});

test("a key nothing reads is said out loud, and still ignored", () => {
  // The silent version of this is the defect the engine reports on in SQL: a setting that describes
  // behaviour the code does not have. Somebody writes `diagnostic` and believes a group is off.
  const root = makeRepo(["tables", "sps"]);
  writeFileSync(
    join(root, ".sqldex.json"),
    JSON.stringify({ diagnostic: { groups: { query: "off" } }, diagnostics: { enabled: false, rulez: {} } }),
  );
  invalidate();

  const warnings: string[] = [];
  const config = get(root, undefined, (message) => warnings.push(message));

  assert.equal(warnings.length, 2, warnings.join(" | "));
  assert.match(warnings[0] ?? "", /nothing reads diagnostic, did you mean diagnostics\?/);
  assert.match(warnings[1] ?? "", /nothing reads rulez in diagnostics/);
  // Ignored, not fatal: a file written for a later sqldex has to keep working on this one.
  assert.equal(config.diagnostics.enabled, false, "the keys it does know still apply");
  assert.deepEqual(config.diagnostics.groups, {});
});

test("the complaint reaches whoever can show it, not whoever reads the file first", () => {
  // A run builds its catalog before it renders anything, so the first read has nowhere to put a
  // warning — and the cache would have swallowed every later chance.
  const root = makeRepo(["tables", "sps"]);
  writeFileSync(join(root, ".sqldex.json"), JSON.stringify({ nonsense: true }));
  invalidate();

  get(root);
  const warnings: string[] = [];
  get(root, undefined, (message) => warnings.push(message));
  assert.equal(warnings.length, 1, "said on the first ask that can hear it");

  const again: string[] = [];
  get(root, undefined, (message) => again.push(message));
  assert.deepEqual(again, [], "and once per project, not once per ask");
});
