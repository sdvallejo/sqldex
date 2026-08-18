/**
 * What counts as a schema project, in the same terms the engine uses.
 *
 * The engine applies this test on its own side and refuses to build a catalog for a directory that
 * fails it, so a disagreement here costs a line in the log rather than a wrong answer. The reason to
 * have it anyway is that this one runs *first*: a repo that merely happens to contain a `.sql` file
 * never starts a server at all, which is the whole point of the guard — indexing a few thousand
 * files uninvited is what it exists to prevent.
 */

"use strict";

const { existsSync, statSync } = require("node:fs");
const { dirname, join } = require("node:path");

/** Config file names, in the order the engine tries them. */
const CONFIG_FILES = [".sqldex.json"];

/**
 * Directory layouts that declare a project on their own.
 *
 * `tablas/` and `sp/` are each enough: nothing else is called that. `tables/`, on the other hand, is
 * a plausible directory in a repo that has nothing to do with a database, so the English layout is
 * only recognised when a routines directory is there too.
 */
const DECLARES = [["tablas"], ["sp"], ["tables", "sps"], ["tables", "functions"]];

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Does this directory declare a project by itself? */
function declares(dir) {
  if (CONFIG_FILES.some((name) => existsSync(join(dir, name)))) return true;
  return DECLARES.some((markers) => markers.every((marker) => isDirectory(join(dir, marker))));
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
 * **A string, and not a `RelativePattern`.** The obvious choice is the editor's own
 * `RelativePattern`, which knows about Windows paths — but the client converts every filter through
 * the protocol on its way in, and the protocol's relative pattern is a different shape (a `baseUri`
 * that is a *string*). A `RelativePattern` from the editor fails that test, and the conversion
 * answers `undefined` rather than raising: the filter survives with no pattern at all, matching
 * every SQL file in the window. Nothing breaks loudly; each server in a multi-root window quietly
 * starts answering about the other projects' files.
 *
 * So: forward slashes, which every glob wants and which a Windows path does not have.
 */
function documentGlob(root) {
  return `${root.replaceAll("\\", "/")}/**/*`;
}

module.exports = { CONFIG_FILES, DECLARES, declares, documentGlob, projectRoot };
