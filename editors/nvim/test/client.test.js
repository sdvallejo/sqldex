/**
 * The one decision the Neovim client makes that can fail silently: what to start.
 *
 * The rest of the client is values — filetypes, the markers that declare a project — and the
 * markers already have a test of their own, in `packages/core`, that compares them against the
 * engine. This is about the other half: a command that is subtly wrong does not produce an error a
 * person sees, because the server it starts dies in a process the editor owns.
 *
 * There is no Lua runtime here, so the file is read rather than run. That is enough for a question
 * about what a literal says, and it is the same thing the markers test does.
 *
 * ESM, unlike the VS Code client's tests next door: that directory is its own package and says
 * nothing about modules, while this one inherits the root's `"type": "module"`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const client = readFileSync(join(import.meta.dirname, "..", "lsp", "sqldex.lua"), "utf8");

test("running the server from a checkout asks for the checkout's sources", () => {
  // Every package points its exports at `dist/`, which is what npm carries and what a clone does not
  // have: a plugin manager copies sources, and even a hand-made clone has no reason to build. The
  // `development` condition is what resolves those exports to `src/` instead, and it has to be asked
  // for. Without it the server comes up, imports `@sqldex/core`, and exits on a file that was never
  // built — the same flag, and the same reason, as the VS Code client's `server.js`.
  const fallback = /return \{ "node",([^}]*)\}/.exec(client);
  assert.ok(fallback, "the checkout fallback is no longer where this test looks for it");
  assert.match(fallback[1], /"--conditions=development"/);
});

test("an installed server is preferred, and is not given the flag", () => {
  // The installed package is built, and asking it for `development` would point it at TypeScript
  // sources it does not ship. So the flag belongs to the checkout branch only.
  const installed = /if vim\.fn\.executable\("sqldex-lsp"\) == 1 then return \{([^}]*)\}/.exec(client);
  assert.ok(installed, "the installed-server branch is no longer where this test looks for it");
  assert.doesNotMatch(installed[1], /conditions/);
});
