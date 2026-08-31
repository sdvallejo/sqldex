/**
 * The Node-version guard `main.ts` runs before opening a connection.
 *
 * Tested against `node-check.ts` rather than `main.ts`: importing `main.ts` opens a real connection
 * on `stdio` as a side effect, which is not something a unit test should do.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nodeTooOld } from "../src/node-check.ts";

test("a Node old enough to run this package is not flagged", () => {
  assert.equal(nodeTooOld("v22.18.0"), undefined);
  assert.equal(nodeTooOld("v24.0.0"), undefined);
});

test("a Node too old to run this package names the version it needs and the one it found", () => {
  const message = nodeTooOld("v18.20.4");
  assert.match(message ?? "", /needs node 22\.18 or newer/);
  assert.match(message ?? "", /v18\.20\.4/);
  // Same major, one minor below the floor — not just a major-version comparison.
  assert.notEqual(nodeTooOld("v22.17.9"), undefined);
});
