/**
 * Layout autodetection and what declares a DDL project.
 *
 * Every case builds a throwaway repo, because the question is always about directories on disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";

import { detectSources, detectTargets, isDdlProject, resolveProject } from "../src/catalog/project.ts";
import { CONFIG_FILES, get, invalidate, schemas } from "../src/config/config.ts";

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
  assert.deepEqual(globs(root), ["tablas/*.sql", "sp/*.sql", "carga-valores/*.sql"]);
  assert.equal(isDdlProject(root), true);
});

test("recognises an English-named one", () => {
  const root = makeRepo(["tables", "sps", "functions", "triggers"]);
  assert.deepEqual(globs(root), ["tables/*.sql", "triggers/*.sql", "sps/*.sql", "functions/*.sql"]);
  assert.equal(isDdlProject(root), true);
});

test("leaves the deploy scripts out of the catalog and into the lint targets", () => {
  const root = makeRepo(["tables", "sps", "deploy_folder"]);
  // They are half a duplicated schema, so they define nothing…
  assert.deepEqual(globs(root), ["tables/*.sql", "sps/*.sql"]);
  // …but they are code that runs, so they are checked against what the others define.
  assert.deepEqual(detectTargets(root, detectSources(root)).map((s) => s.glob), [
    "tables/*.sql",
    "sps/*.sql",
    "deploy_folder/**/*.sql",
  ]);
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
  assert.equal(isDdlProject(makeRepo(["src"], ["src/seed.sql"])), false);
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
  writeFileSync(join(root, ".sqldex.json"), '{ "diagnostics": { "fk_indexes": false } }');
  invalidate();

  const config = get(root, { diagnostics: { fk_indexes: true, join_conditions: false } as never });
  assert.equal(config.diagnostics.fk_indexes, false, "the project file describes this one repo");
  assert.equal(config.diagnostics.join_conditions, false, "the options still apply where it is silent");
  assert.equal(config.diagnostics.unused_variables, true, "and the defaults where both are");
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
