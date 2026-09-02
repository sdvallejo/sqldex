/**
 * Where a schema project begins, as far as a client can tell.
 *
 * The engine decides whether a directory really is one — it reads the files — and refuses to build
 * a catalog for one that is not. This runs *first*, before anything has started, which is why it
 * cannot do the same reading and has to settle for names.
 *
 * The two only stay safe while this one errs towards **yes**. Saying yes where the engine says no
 * costs a server that starts, finds nothing, and writes a line in its log saying so. Saying no
 * where the engine says yes costs a schema project that never produces a diagnostic and never
 * explains why — which is exactly what a list of layout names did to every repo whose routines
 * lived under a name nobody had listed.
 */

"use strict";

const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

/**
 * Names that mark the root of a schema project.
 *
 * `.git` comes last and is the loosest of them: it is what catches the project the layout names
 * miss, and a nearer marker is a better root when there is one. Presence is all that is asked —
 * not that it be a directory — because `.git` is a *file* in a worktree and in a submodule.
 */
const MARKERS = [
  ".sqldex.json",
  "tablas",
  "sp",
  "tables",
  "sps",
  "functions",
  "procedures",
  "triggers",
  ".git",
];

/** Does this directory mark the root of a project? */
function declares(dir) {
  return MARKERS.some((marker) => existsSync(join(dir, marker)));
}

/**
 * The project root at or above a directory, or `undefined` when there is none.
 *
 * Upwards, because a workspace folder is not always the root: opening `repo/tables` to work on one
 * directory is ordinary, and the schema it belongs to is the repo. The walk stops at the filesystem
 * root, and stopping without an answer is the answer — the extension then starts nothing.
 */
function projectRoot(from) {
  let dir = from;
  for (;;) {
    if (declares(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The documents one project's server is asked about, as a glob the language client can carry.
 *
 * **`.sql` only, and by extension rather than by language id.** VS Code has one language mode per
 * file extension, decided by whichever installed extension's id sorts first alphabetically when two
 * disagree — MySQL Shell for VS Code's own `.sql` language beats the editor's built-in one this way.
 * Matching the document selector on `language: "sql"` would then miss every file in the project
 * without a word about why, so the glob does the filtering instead: it only cares what is on disk,
 * which is the same thing `projectRoot` already does.
 *
 * **A string, and not a `RelativePattern`.** The obvious choice is the editor's own
 * `RelativePattern`, which knows about Windows paths — but the client converts every filter through
 * the protocol on its way in, and the protocol's relative pattern is a different shape (a `baseUri`
 * that is a *string*). A `RelativePattern` from the editor fails that test, and the conversion
 * answers `undefined` rather than raising: the filter survives with no pattern at all, matching every
 * file in the window. Nothing breaks loudly; each server in a multi-root window quietly starts
 * answering about the other projects' files.
 *
 * So: forward slashes, which every glob wants and which a Windows path does not have.
 */
function documentGlob(root) {
  return `${root.replaceAll("\\", "/")}/**/*.sql`;
}

module.exports = { MARKERS, declares, documentGlob, projectRoot };
