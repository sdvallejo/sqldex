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

import { detectSources, detectTargets, isDdlProject, resolveProject } from "../src/catalog/project.ts";
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
test("the editor client and the engine agree on what declares a project", () => {
  const client = join(import.meta.dirname, "..", "..", "..", "editors/nvim/lsp/sqldex.lua");
  const source = readFileSync(client, "utf8");

  const block = /local DECLARES = \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(block, "the client's declarations are no longer where this test looks for them");

  const declarations = [...block.matchAll(/\{([^}]*)\}/g)].map((group) =>
    [...group[1]!.matchAll(/"([^"]+)"/g)].map((quoted) => quoted[1]!),
  );
  assert.ok(declarations.length >= 5, "the client declares fewer layouts than the engine recognises");

  // Widened because `CONFIG_FILES` is a tuple of literals, and what is being asked here is whether
  // an arbitrary string from the client happens to be one of them.
  const configFiles: readonly string[] = CONFIG_FILES;
  for (const markers of declarations) {
    const files = markers.filter((marker) => configFiles.includes(marker));
    const dirs = markers.filter((marker) => !configFiles.includes(marker));
    assert.equal(
      isDdlProject(makeRepo(dirs, files)),
      true,
      `the client would start a server for ${markers.join(" + ")}, which the engine does not call a project`,
    );
  }
});
