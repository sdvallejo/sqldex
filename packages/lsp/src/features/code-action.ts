/**
 * `textDocument/codeAction`: turning what the catalog knows into text you would otherwise type.
 *
 * With a few hundred tables and columns running into the dozens, writing an explicit column list by
 * hand is exactly the work a catalog exists to remove. Three families:
 *
 *   - **Expanding `t.*`** into the columns it stands for.
 *   - **Generating a statement** over the table under the cursor: its `SELECT`, its `INSERT` with an
 *     explicit column list, its `UPDATE` keyed on the primary key.
 *   - **Bringing an `aud_X` twin and its triggers back in step** with the table they mirror.
 *
 * Every generated `INSERT` names its columns, and its `VALUES` carries one `/* column *\/` marker per
 * slot. That is not decoration: a positional `INSERT` that has fallen behind its table is among the
 * most common real bugs in a schema of this shape, which is why `query/insert-value-count` exists. A
 * generated statement should not be able to join them.
 */

import {
  auditDefinition,
  auditTableName,
  columnNames,
  identifierAt,
  insertions,
  lineIndex,
  missingColumns,
  parseDDL,
  prefixCount,
  punct,
  qualifier,
  relation,
  tokenize,
  triggerInserts,
  type Column,
  type Table,
  type Token,
} from "@sqldex/core";
import { CodeActionKind, type CodeAction, type Range, type TextEdit } from "vscode-languageserver";

import { rangeOf, uriOf } from "../convert.ts";
import type { At } from "../documents.ts";

/**
 * The token covering an offset, whatever its kind.
 *
 * `identifierAt` only reports identifiers, and the `*` of `t.*` is punctuation.
 */
function tokenAt(tokens: readonly Token[], offset: number): { token: Token; idx: number } | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.s > offset) break;
    // `e` is one past the last character, so an offset level with it is already past the token —
    // the same rule `identifierAt` follows, and the two have to agree or `t.*` is a star to one of
    // them and a dot to the other.
    if (offset >= token.s && offset < token.e) return { token, idx: i };
  }
  return undefined;
}

/** A code action carrying edits to one file. */
function rewrite(title: string, uri: string, edits: TextEdit[]): CodeAction {
  return { title, kind: CodeActionKind.RefactorRewrite, edit: { changes: { [uri]: edits } } };
}

/** The commonest shape of one: replace this range with this text. */
function replace(title: string, uri: string, range: Range, newText: string): CodeAction {
  return rewrite(title, uri, [{ range, newText }]);
}

/**
 * Expanding a `*` into the columns it stands for.
 *
 * `t.*` keeps the qualifier on every column, because that is the form that survives having another
 * table joined in later. A bare `*` is only expanded when the statement has exactly one relation:
 * with two, which columns it means — and in what order — is the server's business, and guessing
 * would produce a list that silently differs from what runs today.
 */
function expandStar(at: At, out: CodeAction[]): void {
  const tokens = at.lexed.tokens;
  const found = tokenAt(tokens, at.offset);
  if (!found || !punct(found.token, "*")) return;

  const before = tokens[found.idx - 1];
  const qualifierToken = tokens[found.idx - 2];
  let name: string | undefined;
  let from = found.token.s;
  if (punct(before, ".") && qualifierToken?.t === "id") {
    name = qualifierToken.v;
    from = qualifierToken.s;
  }

  let resolved;
  if (name !== undefined) {
    resolved = qualifier(at.resolve, at.analysis, at.scope, name);
  } else if (at.analysis.relations.length === 1) {
    const only = at.analysis.relations[0]!;
    resolved = relation(at.resolve, at.scope, only);
    name = only.alias;
  }

  const names = columnNames(resolved);
  if (names.length === 0) return;

  out.push(
    replace(
      `Expand ${name !== undefined ? `${name}.*` : "*"} into its ${names.length} columns`,
      at.document.uri,
      rangeOf(lineIndex(at.text), { s: from, e: found.token.e }),
      names.map((column) => (name !== undefined ? `${name}.${column}` : column)).join(", "),
    ),
  );
}

/** One `/* column *\/` marker per slot, named, so a value written into the wrong one shows up. */
function markers(columns: readonly Column[]): string {
  return columns.map((column) => `/* ${column.name} */`).join(", ");
}

/**
 * Statements generated over the table under the cursor.
 *
 * They replace the name that triggered them, so typing a table and asking for its `SELECT` is one
 * gesture. The `UPDATE` is keyed on the primary key rather than left bare, which is both what you
 * meant and what keeps `query/unfiltered-write` quiet.
 */
function generateStatements(at: At, out: CodeAction[]): void {
  const found = identifierAt(at.lexed, at.offset);
  // A qualified name is a column of something, never a table to generate over.
  if (!found || found.qualifier !== undefined) return;

  const table = at.workspace.catalog.table(found.token.v);
  if (!table || table.columns.length === 0) return;

  const uri = at.document.uri;
  const range = rangeOf(lineIndex(at.text), found.token);
  const name = table.name;

  out.push(
    replace(
      `Generate SELECT over ${name}`,
      uri,
      range,
      `SELECT ${table.columns.map((column) => column.name).join(", ")}\nFROM ${name}`,
    ),
  );

  // An `AUTO_INCREMENT` column is the server's to fill, and a generated one cannot be written to at
  // all — MySQL rejects the statement.
  const insertable = table.columns.filter((column) => !column.autoIncrement && !column.generated);
  if (insertable.length > 0) {
    out.push(
      replace(
        `Generate INSERT into ${name}`,
        uri,
        range,
        `INSERT INTO ${name} (${insertable.map((column) => column.name).join(", ")})\nVALUES (${markers(insertable)})`,
      ),
    );
  }

  const fold = (value: string): string => at.workspace.dialect.foldIdentifier(value, false);
  const key = new Set(table.primaryKey.map(fold));
  const assignments = table.columns
    .filter((column) => !column.generated && !key.has(fold(column.name)))
    .map((column) => `${column.name} = /* ${column.name} */`);
  if (assignments.length > 0) {
    const where =
      table.primaryKey.length > 0
        ? table.primaryKey.map((column) => `${column} = /* ${column} */`).join(" AND ")
        : "/* condition */";
    out.push(
      replace(
        `Generate UPDATE of ${name}`,
        uri,
        range,
        `UPDATE ${name}\nSET ${assignments.join(", ")}\nWHERE ${where}`,
      ),
    );
  }
}

/**
 * Bringing an `aud_X` table and its triggers back in step with `X`.
 *
 * Two separate actions, because they touch two different files and one is useful without the other:
 * the columns go into the twin's file, the triggers live beside the table the cursor is on.
 *
 * **No `ALTER TABLE` is generated**, deliberately. A repo of this shape turns a changed
 * `CREATE TABLE` into its migration by its own means, so emitting one here would duplicate that and
 * risk disagreeing with it. Editing the DDL is the whole job.
 */
function synchroniseAudit(at: At, out: CodeAction[]): void {
  const workspace = at.workspace;
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const parsed = parseDDL(workspace.dialect, at.text, at.lexed);

  // The table the cursor is inside, so a file defining several offers the right one.
  let table = parsed.tables.findLast(
    (candidate) => !candidate.temporary && at.offset >= candidate.range.s && at.offset <= candidate.range.e,
  );
  // A cursor sitting in a trigger is past the `CREATE TABLE`; fall back to the file's only one.
  if (!table && parsed.tables.length === 1 && !parsed.tables[0]!.temporary) table = parsed.tables[0];
  if (!table) return;

  const catalogued = workspace.catalog.table(auditTableName(table.name));
  if (!catalogued?.file) return;

  // Re-parsed from its own file rather than taken from the catalog: the insertion needs each
  // column's offsets **in that file**, and an unsaved buffer of it is not what the edit applies to.
  const auditSrc = workspace.catalog.read(catalogued.file);
  if (auditSrc === undefined) return;
  const twin: Table | undefined = parseDDL(workspace.dialect, auditSrc, tokenize(auditSrc)).tables.find(
    (candidate) => fold(candidate.name) === fold(catalogued.name),
  );
  if (!twin) return;

  const missing = missingColumns(workspace.dialect, table, twin);
  if (missing.length > 0) {
    const starts = lineIndex(auditSrc);
    const edits = insertions(workspace.dialect, table, twin).map((insertion) => ({
      range: rangeOf(starts, { s: insertion.after, e: insertion.after }),
      // The comma **leads** each definition rather than trailing it. The insertion point sits
      // between the anchor and whatever punctuation follows it, so a trailing comma would steal the
      // anchor's own: `NOT NULL` + `\n  new` + `,` leaves the anchor without one. Leading it gives
      // `NOT NULL` + `,\n  new` + `,`, which is well formed whether the anchor was the last column
      // or not.
      newText: insertion.columns.map((column) => `,\n  ${auditDefinition(column.definition)}`).join(""),
    }));
    out.push(
      rewrite(
        `Add ${missing.map((column) => column.name).join(", ")} to ${twin.name}`,
        uriOf(catalogued.file),
        edits,
      ),
    );
  }

  // The triggers: rewritten to carry every column, in the table's order.
  const prefix = prefixCount(workspace.dialect, table, twin);
  const starts = lineIndex(at.text);
  const edits: TextEdit[] = [];
  let rewritten = 0;
  for (const trigger of parsed.triggers) {
    if (fold(trigger.table) !== fold(table.name)) continue;
    const inserts = triggerInserts(workspace.dialect, at.lexed.tokens, trigger.body, table, twin.name, prefix);
    if (inserts.length > 0) rewritten++;
    for (const insert of inserts) edits.push({ range: rangeOf(starts, insert), newText: insert.text });
  }

  if (edits.length > 0) {
    out.push(
      rewrite(
        `Rewrite the ${rewritten} audit trigger${rewritten === 1 ? "" : "s"} of ${table.name}`,
        at.document.uri,
        edits,
      ),
    );
  }
}

/** Whether the file holds DDL at all, which is cheaper to ask of the text than of a parse. */
const DDL = /create\s+table/i;

/** The actions available at a position. */
export function codeActions(at: At): CodeAction[] {
  const out: CodeAction[] = [];
  expandStar(at, out);
  generateStatements(at, out);
  // Only a file that defines a table can be out of step with that table's twin.
  if (DDL.test(at.text)) synchroniseAudit(at, out);
  return out;
}
