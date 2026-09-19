/**
 * The fast lexer's decimal branch: `digits[.digits][e[+-]digits]`, and where it must stop
 * short of that.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { tokenize } from "../src/syntax/fast/lexer.ts";

test("an integer exponent is part of the number", () => {
  const [tok] = tokenize("1e9").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1e9");
});

test("a decimal exponent is part of the number", () => {
  const [tok] = tokenize("2.5e2").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "2.5e2");
});

test("a negative exponent is part of the number", () => {
  const [tok] = tokenize("1E-3").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1E-3");
});

test("a positive exponent sign is part of the number", () => {
  const [tok] = tokenize("1e+3").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1e+3");
});

test("a bare trailing e with no digits after it is not an exponent", () => {
  const [tok] = tokenize("1e").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1");
});

test("a trailing e with a sign but no digits is not an exponent", () => {
  const [tok] = tokenize("1e+").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1");
});

test("e followed by a non-digit, non-sign character is not an exponent", () => {
  const [tok] = tokenize("1ex").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1");
});

test("exponent digits running into an identifier are not taken as an exponent", () => {
  const [tok] = tokenize("1e3abc").tokens;
  assert.equal(tok?.t, "num");
  assert.equal(tok?.v, "1");
});
