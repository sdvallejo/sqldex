/**
 * `--diff`: which files this branch changed.
 *
 * The catalog is still built from the **whole** project — a change is judged against the schema it
 * lands in, not against itself — and only the sweep is narrowed. That is the difference between
 * "check what changed" and "check the changed files in isolation", and the second one cannot see a
 * foreign key pointing at a table that a different file defines.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** The environment variables a CI job already knows the base from, in the order they are tried. */
export const BASE_VARS = ["CI_MERGE_REQUEST_DIFF_BASE_SHA", "GITHUB_BASE_REF"] as const;

export class DiffError extends Error {}

/**
 * The base to diff against.
 *
 * `--diff` with no value asks the CI job where it forked from, rather than guessing a branch name:
 * a wrong guess does not fail, it silently lints either everything or nothing, which is the worst
 * of the three outcomes.
 */
export function baseFrom(given: string | undefined, env: Record<string, string | undefined>): string {
  if (given !== undefined && given !== "") return given;
  for (const name of BASE_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  throw new DiffError(
    `--diff needs a base: pass one (--diff origin/master), or run where ${BASE_VARS.join(" or ")} is set`,
  );
}

/**
 * Absolute paths of the `.sql` files that changed since `base`.
 *
 * Three dots, so the comparison starts at the merge base: two dots would report every file the
 * target branch has moved on by since, which on a long-lived branch is most of the repo.
 *
 * Deletions are left out (`--diff-filter=ACMR`). A file that is gone cannot be linted, and it is
 * not an error that it is gone.
 *
 * `--relative` because git reports paths from the **repository** root, and the project root is not
 * always that: a schema living in a subdirectory of a larger repo would otherwise get every path
 * resolved one level too high, and match nothing. It narrows to the subtree as well, which is the
 * same set of files the sweep would have considered anyway.
 */
export function changedFiles(root: string, base: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--name-only", "--relative", "--diff-filter=ACMR", `${base}...HEAD`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      // Captured rather than inherited, so git's complaint about an unknown ref arrives inside the
      // error we raise instead of appearing on the terminal ahead of it, out of order.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const said = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new DiffError(`git could not diff against ${base}${said ? `: ${said.split("\n")[0]}` : ""}`);
  }

  return out
    .split("\n")
    .filter((line) => line.endsWith(".sql"))
    .map((line) => resolve(root, line));
}
