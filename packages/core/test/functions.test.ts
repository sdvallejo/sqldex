/**
 * The built-in function catalog.
 *
 * Most of what is worth asserting about a table of data is not any one row but the shape all of
 * them hold, because that is what a hand-written list loses first: an entry gets added in a hurry
 * with the name spelled one way in the key and another in the signature, and nothing notices until
 * signature help highlights the wrong argument.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { builtin, FUNCTIONS, mysql } from "../src/index.ts";

test("a function is found however it was capitalised", () => {
  for (const written of ["coalesce", "COALESCE", "Coalesce"]) {
    const entry = builtin(written);
    assert.equal(entry?.name, "COALESCE", `${written} did not resolve`);
    assert.equal(entry?.signature, "COALESCE(value, ...)");
  }
});

test("a name that is not a function claims nothing", () => {
  assert.equal(builtin("order_total"), undefined);
  assert.equal(builtin(""), undefined);
});

test("the dialect serves the same catalog", () => {
  assert.equal(mysql.builtin("now")?.name, "NOW");
  assert.equal(mysql.functions, FUNCTIONS);
});

test("every entry agrees with the key it is filed under", () => {
  for (const [key, entry] of FUNCTIONS) {
    assert.equal(entry.name, key, `${key} is filed under a name it does not carry`);
    assert.equal(key, key.toUpperCase(), `${key} is not upper case, so a lookup would miss it`);
  }
});

test("every signature starts with the function's own name", () => {
  // Signature help slices the name off the front to make the `detail` a completion list shows, and
  // splits the rest on its parentheses to find the argument the cursor is in. A signature that
  // opened with anything else would produce a plausible-looking label with the wrong text in it.
  for (const entry of FUNCTIONS.values()) {
    assert.ok(
      entry.signature.startsWith(entry.name),
      `${entry.name} has a signature that does not open with its name: ${entry.signature}`,
    );
  }
});

test("every entry says what it does and what family it is in", () => {
  for (const entry of FUNCTIONS.values()) {
    assert.ok(entry.summary.length > 0, `${entry.name} has no summary`);
    assert.ok(entry.category.length > 0, `${entry.name} has no category`);
  }
});

test("the ones a schema repository is written with are all here", () => {
  // Not a sample: these are the names whose absence would be noticed immediately, because they are
  // what procedures that move dates, build strings and read JSON are made of. A refactor of the
  // table that dropped one would leave hover silently dead exactly where it is used most.
  for (const name of [
    "COALESCE",
    "CONCAT",
    "CONCAT_WS",
    "NOW",
    "CURDATE",
    "SUM",
    "COUNT",
    "GROUP_CONCAT",
    "SUBSTRING_INDEX",
    "DATE_FORMAT",
    "STR_TO_DATE",
    "TIMESTAMPDIFF",
    "DATE_ADD",
    "LAST_DAY",
    "JSON_EXTRACT",
    "JSON_OBJECT",
    "JSON_UNQUOTE",
    "IFNULL",
    "ROW_NUMBER",
  ]) {
    assert.ok(builtin(name), `${name} is not in the catalog`);
  }
});
