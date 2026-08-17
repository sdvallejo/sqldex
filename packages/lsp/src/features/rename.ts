/**
 * `textDocument/rename` and `textDocument/prepareRename`.
 *
 * Renaming is find-references with an edit attached, so it inherits every guard from there: whole
 * identifier tokens rather than substrings — otherwise renaming `orders` would maul `aud_orders`
 * and `LogOrders`, which are different tables — and, for a column, only the uses that really belong
 * to its table.
 *
 * ## What it deliberately does not do
 *
 * **It does not rename the file.** `tables/orders.sql` keeps its name after `orders` becomes
 * something else. The catalog keys tables by what the DDL says and not by the filename, so nothing
 * breaks; and in a repo where those files are regenerated from the server, the generator is the
 * authority on what they are called.
 *
 * **It does not follow naming conventions between tables.** Renaming `orders.status` leaves
 * `aud_orders.status` alone, because that is a different table's column and guessing otherwise
 * would edit files nobody asked about. The safety net is already in place: `audit/table-out-of-sync`
 * reports the audit table as out of step the moment the rename lands.
 */

import { lineIndex } from "@sqldex/core";
import type { Range, TextEdit, WorkspaceEdit } from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { At } from "../documents.ts";
import { hits, targetAt } from "./references.ts";

/**
 * Characters that may appear in a bare MySQL identifier.
 *
 * The range above ASCII is what makes `Cálculo` a name rather than a syntax error; a schema written
 * by people who speak a language with accents is full of them.
 */
const BARE_IDENTIFIER = /^[0-9A-Za-z_$\u0080-\uFFFF]+$/;

function needsQuoting(name: string): boolean {
  if (!BARE_IDENTIFIER.test(name)) return true;
  // MySQL does allow a leading digit as long as the name is not *all* digits. Quoting it anyway is
  // one rule instead of two and is correct in both cases.
  return /^[0-9]/.test(name);
}

/**
 * How the new name has to be written at a given use.
 *
 * Backticks are kept when they were already there — a column called `` `order` `` stops being valid
 * the moment they come off — and added when the new name needs them. The escaping is the dialect's,
 * so a name containing the delimiter comes out right without this module knowing what it is.
 */
function replacement(at: At, newName: string, quoted: boolean): string {
  if (quoted || needsQuoting(newName)) return at.workspace.dialect.quoteIdentifier(newName);
  return newName;
}

/**
 * Whether the cursor is on something this can rename, and what to put in the input box.
 *
 * The placeholder is the catalog's spelling rather than what is under the cursor: renaming from
 * `ORDERS` should offer `orders` to edit, because that is the name being changed.
 */
export function prepareRename(at: At): { range: Range; placeholder: string } | undefined {
  const found = targetAt(at);
  if (!found) return undefined;
  return { range: rangeOf(lineIndex(at.text), found.token), placeholder: found.target.name };
}

/** The whole edit, across every file that uses the name. */
export function rename(at: At, newName: string): WorkspaceEdit | undefined {
  if (newName === "") return undefined;

  const found = targetAt(at);
  if (!found) return undefined;

  const changes: Record<string, TextEdit[]> = {};
  for (const file of hits(at, found)) {
    const starts = lineIndex(file.src);
    changes[uriOf(file.path)] = file.refs.map((ref) => ({
      range: rangeOf(starts, ref),
      newText: replacement(at, newName, ref.quoted),
    }));
  }

  // Nothing to change is not an empty edit: a client shown one reports a successful rename that
  // did nothing, which is worse than being told the request went nowhere.
  if (Object.keys(changes).length === 0) return undefined;
  return { changes };
}
