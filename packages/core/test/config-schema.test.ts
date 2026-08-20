/**
 * The editor's schema for `.sqldex.json` is a copy of a decision this package owns.
 *
 * A copy is the thing that goes quietly wrong: nothing fails when the two drift, the editor just
 * starts underlining a key that is perfectly valid, or stops offering one that exists. The client
 * for Neovim has the same problem with its list of what declares a project, and the same answer —
 * read the copy and compare it against the source.
 *
 * The schema is read out of the extension rather than restated here, so this fails when the copy
 * moves rather than when it is wrong in some way this file happened to predict.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { defaults } from "../src/config/config.ts";

const SCHEMA = join(import.meta.dirname, "..", "..", "..", "editors/vscode/schemas/sqldex.schema.json");

interface Schema {
  properties: Record<string, { properties?: Record<string, unknown> }>;
}

test("the editor's schema offers exactly the keys a project file may set", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as Schema;

  // `root_markers` is used to *find* the config file, so a config file cannot set it.
  const settable = Object.keys(defaults).filter((key) => key !== "root_markers");
  assert.deepEqual(Object.keys(schema.properties).sort(), settable.sort());
});

test("and the same keys inside the two nested objects", () => {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as Schema;
  for (const key of ["diagnostics", "inlay_hints", "syntax_check"] as const) {
    assert.deepEqual(
      Object.keys(schema.properties[key]?.properties ?? {}).sort(),
      Object.keys(defaults[key]).sort(),
      key,
    );
  }
});
