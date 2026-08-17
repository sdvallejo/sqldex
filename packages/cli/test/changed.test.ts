/**
 * `--diff`: where the base comes from, and what git is asked.
 *
 * The git half runs against a repository built for the test and **skips** if git is not installed,
 * rather than failing: `npm test` is supposed to need nothing but a checkout, and git being present
 * is a fair assumption but not one worth turning into a red suite.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { baseFrom, changedFiles, DiffError } from "../src/changed.ts";

// -------------------------------------------------------------------- the base

test("an explicit base is taken as given", () => {
  assert.equal(baseFrom("origin/master", { CI_MERGE_REQUEST_DIFF_BASE_SHA: "abc" }), "origin/master");
});

test("without one, the CI job is asked — GitLab first", () => {
  assert.equal(
    baseFrom(undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: "abc", GITHUB_BASE_REF: "main" }),
    "abc",
  );
  assert.equal(baseFrom(undefined, { GITHUB_BASE_REF: "main" }), "main");
});

test("an empty variable is not a base", () => {
  // An unset variable and one set to nothing are the same thing in a CI config, and `git diff ...`
  // against the empty string is a diff against the working tree — a silently different answer.
  assert.throws(() => baseFrom(undefined, { CI_MERGE_REQUEST_DIFF_BASE_SHA: "" }), DiffError);
  assert.throws(() => baseFrom("", {}), DiffError);
});

test("with nowhere to get it, the error names the variables it looked at", () => {
  assert.throws(() => baseFrom(undefined, {}), (error: Error) => {
    assert.ok(error instanceof DiffError);
    assert.match(error.message, /CI_MERGE_REQUEST_DIFF_BASE_SHA or GITHUB_BASE_REF/);
    return true;
  });
});

// --------------------------------------------------------------------- the diff

function haveGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A repository with one commit, and a second commit that touches three files. */
function repoWithABranch(): string {
  const root = mkdtempSync(join(tmpdir(), "sqldex-git-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");

  mkdirSync(join(root, "schema", "tables"), { recursive: true });
  writeFileSync(join(root, "schema", "tables", "customers.sql"), "CREATE TABLE customers (id int);\n");
  writeFileSync(join(root, "README.md"), "before\n");
  git("add", "-A");
  git("commit", "-qm", "first");

  git("checkout", "-q", "-b", "work");
  writeFileSync(join(root, "schema", "tables", "orders.sql"), "CREATE TABLE orders (id int);\n");
  writeFileSync(join(root, "README.md"), "after\n");
  writeFileSync(join(root, "top-level.sql"), "SELECT 1;\n");
  git("add", "-A");
  git("commit", "-qm", "second");

  return root;
}

test("only the .sql files that changed, as absolute paths", { skip: !haveGit() }, () => {
  const root = repoWithABranch();
  const changed = changedFiles(root, "main");
  assert.deepEqual(changed, [join(root, "schema/tables/orders.sql"), join(root, "top-level.sql")]);
});

test("paths come back relative to the project root, not the repository's", { skip: !haveGit() }, () => {
  // The reason `--relative` is passed. Asked from `schema/`, git would otherwise answer
  // `schema/tables/orders.sql`, which resolved against `schema/` names a file that does not exist —
  // and the sweep would then lint nothing at all while reporting success.
  const root = repoWithABranch();
  const changed = changedFiles(join(root, "schema"), "main");
  assert.deepEqual(changed, [join(root, "schema/tables/orders.sql")]);
});

test("a base git cannot resolve is an error, not an empty run", { skip: !haveGit() }, () => {
  const root = repoWithABranch();
  assert.throws(() => changedFiles(root, "no-such-ref"), DiffError);
});
