/**
 * `textDocument/codeAction`: turning what the catalog knows into text you would otherwise type.
 *
 * Two different triggers, and the file is organised around that split:
 *
 *   - **Cursor-triggered rewrites.** Expanding `t.*`, generating a statement over the table under the
 *     cursor, bringing an `aud_X` twin and its triggers back in step. `CodeActionKind.RefactorRewrite`
 *     — offered wherever the cursor happens to sit, with no finding involved.
 *   - **Diagnostic quick fixes.** The lightbulb a finding itself offers: rename an unknown name to the
 *     one candidate close enough to be worth suggesting, delete what a rule already proved is surplus,
 *     regenerate an `INSERT` that has fallen behind its table. `CodeActionKind.QuickFix`, each anchored
 *     to the specific `Diagnostic` it resolves via `context.diagnostics` — never guessed at from the
 *     cursor, because a diagnostic already says exactly what is wrong and where.
 *
 * Every generated `INSERT` names its columns, and its `VALUES` carries one `/* column *\/` marker per
 * slot. That is not decoration: a positional `INSERT` that has fallen behind its table is among the
 * most common real bugs in a schema of this shape, which is why `query/insert-value-count` exists. A
 * generated statement should not be able to join them.
 *
 * **The quick fixes only act where the edit is unambiguous.** A "did you mean" rename is offered only
 * when exactly one candidate is close enough; an `INSERT` under-supplied on values is only completed
 * when there is one accepted count to complete it to; an unused variable is removed from its own
 * `DECLARE`, alone or shared with others, but a `DECLARE` reordered wholesale refuses the one shape
 * — a handler's — a plain scan cannot read correctly. Where the right edit cannot be known, the rule
 * still reports — there is just no lightbulb. Guessing wrong here is worse than not offering
 * anything, the same principle every rule in `@sqldex/core` is already written against.
 */

import {
  analyze,
  arity,
  auditDefinition,
  auditTableName,
  collect,
  columnNames,
  identifierAt,
  insertions,
  insertTarget,
  kw,
  kwAny,
  lineIndex,
  matchingParen,
  missingColumns,
  parseDDL,
  parseRoutines,
  prefixCount,
  punct,
  qualifier,
  relation,
  statementBounds,
  tokenize,
  triggerInserts,
  type Column,
  type InsertTarget,
  type Lexed,
  type Local,
  type Span,
  type Table,
  type Token,
} from "@sqldex/core";
import { CodeActionKind, type CodeAction, type Diagnostic, type Range, type TextEdit } from "vscode-languageserver";

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

/** A code action carrying edits to one file, offered from wherever the cursor sits. */
function rewrite(title: string, uri: string, edits: TextEdit[]): CodeAction {
  return { title, kind: CodeActionKind.RefactorRewrite, edit: { changes: { [uri]: edits } } };
}

/** The commonest shape of one: replace this range with this text. */
function replace(title: string, uri: string, range: Range, newText: string): CodeAction {
  return rewrite(title, uri, [{ range, newText }]);
}

/** A code action anchored to the diagnostic(s) it resolves — the lightbulb on the finding itself. */
function fix(title: string, uri: string, edits: TextEdit[], diagnostics: Diagnostic[]): CodeAction {
  return { title, kind: CodeActionKind.QuickFix, diagnostics, edit: { changes: { [uri]: edits } } };
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

/** Where an `aud_X` twin's file is, its parsed `Table`, and the source it was parsed from. */
interface Twin {
  catalogued: Table & { file: string };
  auditSrc: string;
  twin: Table;
}

/**
 * The `aud_X` twin of a table, re-parsed from its own file.
 *
 * Re-parsed rather than taken from the catalog: the insertion needs each column's offsets **in that
 * file**, and an unsaved buffer of it is not what the edit applies to.
 */
function resolveTwin(workspace: At["workspace"], table: Table): Twin | undefined {
  const catalogued = workspace.catalog.table(auditTableName(table.name));
  if (!catalogued?.file) return undefined;

  const auditSrc = workspace.catalog.read(catalogued.file);
  if (auditSrc === undefined) return undefined;

  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const twin = parseDDL(workspace.dialect, auditSrc, tokenize(auditSrc)).tables.find(
    (candidate) => fold(candidate.name) === fold(catalogued.name),
  );
  if (!twin) return undefined;

  return { catalogued: catalogued as Table & { file: string }, auditSrc, twin };
}

/** The edit that adds a table's missing columns to its twin, or nothing where none are missing. */
function auditColumnFix(
  workspace: At["workspace"],
  table: Table,
  { catalogued, auditSrc, twin }: Twin,
): { title: string; uri: string; edits: TextEdit[] } | undefined {
  const missing = missingColumns(workspace.dialect, table, twin);
  if (missing.length === 0) return undefined;

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

  return { title: `Add ${missing.map((column) => column.name).join(", ")} to ${twin.name}`, uri: uriOf(catalogued.file), edits };
}

/** The edit that rewrites `table`'s audit triggers to carry every column, or nothing where none change. */
function auditTriggerFix(
  at: At,
  table: Table,
  twin: Table,
  parsed: { triggers: ReturnType<typeof parseDDL>["triggers"] },
): { title: string; uri: string; edits: TextEdit[] } | undefined {
  const workspace = at.workspace;
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
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

  if (edits.length === 0) return undefined;
  return { title: `Rewrite the ${rewritten} audit trigger${rewritten === 1 ? "" : "s"} of ${table.name}`, uri: at.document.uri, edits };
}

/** Whether the file holds DDL at all, which is cheaper to ask of the text than of a parse. */
const DDL = /create\s+table/i;

/** The offset a `Diagnostic`'s range starts at, in this document. */
function startOf(at: At, diagnostic: Diagnostic): number {
  return at.document.offsetAt(diagnostic.range.start);
}

/**
 * Bringing an `aud_X` twin and its triggers back in step with the table they mirror.
 *
 * One pass over every table in the file, not just the one under the cursor, because a diagnostic
 * the client is asking a quick fix for can be anywhere — a lightbulb clicked on a different table's
 * squiggly line is not "the cursor's" table. Each of the two possible edits is offered **once**,
 * as a `QuickFix` carrying the diagnostic(s) it resolves where one is present, or — for the table
 * the cursor is actually inside, with nothing to point at — a plain `RefactorRewrite`. Computing
 * both from the one function is what keeps a click that is both "on the cursor's table" and "on a
 * diagnostic" from offering the same edit twice under two different titles.
 *
 * **No `ALTER TABLE` is generated**, deliberately. A repo of this shape turns a changed
 * `CREATE TABLE` into its migration by its own means, so emitting one here would duplicate that and
 * risk disagreeing with it. Editing the DDL is the whole job.
 */
function synchroniseAudit(at: At, diagnostics: readonly Diagnostic[], out: CodeAction[]): void {
  const workspace = at.workspace;
  const parsed = parseDDL(workspace.dialect, at.text, at.lexed);
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);

  const tableDiags = diagnostics.filter((d) => d.code === "audit/table-out-of-sync");
  const triggerDiags = diagnostics.filter((d) => d.code === "audit/trigger-missing-column");

  // The table the cursor is inside, so a file defining several still offers the right one from the
  // cursor when nothing else picks a table. A cursor sitting in a trigger is past the `CREATE
  // TABLE`; fall back to the file's only one.
  let cursorTable = parsed.tables.findLast(
    (candidate) => !candidate.temporary && at.offset >= candidate.range.s && at.offset <= candidate.range.e,
  );
  if (!cursorTable && parsed.tables.length === 1 && !parsed.tables[0]!.temporary) cursorTable = parsed.tables[0];

  for (const table of parsed.tables) {
    if (table.temporary) continue;

    const tableHere = tableDiags.filter((d) => {
      const o = startOf(at, d);
      return o >= table.range.s && o <= table.range.e;
    });
    const tablesTriggers = parsed.triggers.filter((t) => fold(t.table) === fold(table.name));
    const triggerHere = triggerDiags.filter((d) => {
      const o = startOf(at, d);
      return tablesTriggers.some((t) => o >= t.nameSpan.s && o < t.nameSpan.e);
    });

    if (table !== cursorTable && tableHere.length === 0 && triggerHere.length === 0) continue;

    const twin = resolveTwin(workspace, table);
    if (!twin) continue;

    const columnFix = auditColumnFix(workspace, table, twin);
    if (columnFix) {
      out.push(
        tableHere.length > 0
          ? fix(columnFix.title, columnFix.uri, columnFix.edits, tableHere)
          : rewrite(columnFix.title, columnFix.uri, columnFix.edits),
      );
    }

    const triggerFix = auditTriggerFix(at, table, twin.twin, parsed);
    if (triggerFix) {
      out.push(
        triggerHere.length > 0
          ? fix(triggerFix.title, triggerFix.uri, triggerFix.edits, triggerHere)
          : rewrite(triggerFix.title, triggerFix.uri, triggerFix.edits),
      );
    }
  }
}

/**
 * Levenshtein distance. Identifiers in a schema repo are short — a few dozen characters at most —
 * so the quadratic table this builds is never worth optimising away.
 */
function distance(a: string, b: string): number {
  const row: number[] = [];
  for (let j = 0; j <= b.length; j++) row[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = a[i - 1] === b[j - 1] ? diag : 1 + Math.min(diag, row[j]!, row[j - 1]!);
      diag = row[j]!;
      row[j] = next;
    }
  }
  return row[b.length]!;
}

/**
 * The one candidate close enough to be worth suggesting, or nothing.
 *
 * **Only ever one.** A tie between two candidates at the same distance is not a suggestion this
 * function is entitled to make — it would be picking arbitrarily between two guesses and calling
 * the result a fix. The distance itself is bounded relative to the name's own length, so a five-
 * letter typo does not go looking for its "closest" match forty characters away.
 */
function nearest(name: string, candidates: Iterable<string>): string | undefined {
  const folded = name.toLowerCase();
  const limit = Math.max(2, Math.floor(name.length / 3));

  let best: string | undefined;
  let bestDist = Infinity;
  let tied = false;
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate.toLowerCase() === folded) continue;

    const d = distance(folded, candidate.toLowerCase());
    if (d > limit) continue;

    if (d < bestDist) {
      best = candidate;
      bestDist = d;
      tied = false;
    } else if (d === bestDist) {
      tied = true;
    }
  }

  return tied ? undefined : best;
}

/** The same derivation `documents.ts#at` makes for the request's own cursor, but for an arbitrary
 * offset — a diagnostic can sit anywhere in the file relative to where the code-action request was
 * made, so its "did you mean" has to be worked out at *its* position, not the cursor's. */
function contextAt(at: At, offset: number): { analysis: ReturnType<typeof analyze>; scope: ReturnType<typeof collect> } {
  const dialect = at.workspace.dialect;
  const routines = parseRoutines(at.text, at.lexed).routines;
  return {
    analysis: analyze(dialect, at.text, at.lexed.tokens, offset),
    scope: collect(dialect, at.text, at.lexed.tokens, offset, routines),
  };
}

/** The `INSERT`/`REPLACE` statement enclosing `offset`, and where it points. */
function findInsertTarget(at: At, offset: number): InsertTarget | undefined {
  const tokens = at.lexed.tokens;
  const { from, to } = statementBounds(tokens, offset);
  for (let i = from; i <= to; i++) {
    if (kw(tokens[i], "INSERT") || kw(tokens[i], "REPLACE")) {
      const target = insertTarget({ tokens, catalog: at.workspace.catalog }, i);
      if (target) return target;
    }
  }
  return undefined;
}

/** The columns of the table a qualified `x.column` at token index `idx` resolves `x` against. */
function columnsForQualifiedToken(at: At, offset: number, idx: number): string[] | undefined {
  const tokens = at.lexed.tokens;
  const qualifierToken = tokens[idx - 2];
  if (!qualifierToken || !punct(tokens[idx - 1], ".")) return undefined;

  const { analysis, scope } = contextAt(at, offset);
  const resolved = qualifier(at.resolve, analysis, scope, qualifierToken.v);
  const names = columnNames(resolved);
  return names.length > 0 ? names : undefined;
}

/** Every column of every relation the statement at `offset` resolves — the set a bare, unknown
 * column name is compared against. */
function columnsForStatement(at: At, offset: number): string[] | undefined {
  const { analysis, scope } = contextAt(at, offset);
  const names = new Set<string>();
  for (const rel of analysis.relations) {
    for (const name of columnNames(relation(at.resolve, scope, rel))) names.add(name);
  }
  return names.size > 0 ? [...names] : undefined;
}

/** The `CREATE TABLE` in `at.text` that `offset` falls inside — the DDL equivalent of
 * `columnsForStatement`, since `schema/*` rules are about one table's own text and never need the
 * catalog to say which one that is. */
function tableAt(at: At, offset: number): Table | undefined {
  const parsed = parseDDL(at.workspace.dialect, at.text, at.lexed);
  return parsed.tables.find((t) => offset >= t.range.s && offset <= t.range.e);
}

/**
 * `schema/fk-unknown-column`'s candidates: the declaring table's own columns when the offending
 * name is one of the foreign key's own, the referenced table's when it is one of the referenced
 * ones — the same two-sided read the rule itself does, worked out from which of a key's four spans
 * the offset falls in rather than trusted to be handed over.
 */
function columnsForFkColumn(at: At, offset: number): string[] | undefined {
  const table = tableAt(at, offset);
  if (!table) return undefined;

  for (const fk of table.foreignKeys) {
    if (fk.columnSpans.some((span) => offset >= span.s && offset < span.e)) {
      return table.columns.map((c) => c.name);
    }
    if (fk.refColumnSpans.some((span) => offset >= span.s && offset < span.e)) {
      const target = fk.refTable ? at.workspace.catalog.table(fk.refTable) : undefined;
      return target?.columns.map((c) => c.name);
    }
  }
  return undefined;
}

/** `schema/index-unknown-column`'s candidates: the same table's own columns, whether the offending
 * name came from the primary key or a secondary index — both are checked against the one table. */
function columnsForIndexColumn(at: At, offset: number): string[] | undefined {
  return tableAt(at, offset)?.columns.map((c) => c.name);
}

/** Candidate names for a "did you mean", one builder per rule that reports an unknown name. */
const RENAME_CANDIDATES: Record<string, (at: At, offset: number, idx: number) => Iterable<string> | undefined> = {
  "names/unknown-table": (at) => [...at.workspace.catalog.tables.values()].map((t) => t.name),
  "names/unknown-routine": (at) => [...at.workspace.catalog.routines.values()].map((r) => r.name),
  "names/unknown-alias": (at, offset) => {
    const { analysis } = contextAt(at, offset);
    const names: string[] = [];
    for (const rel of analysis.relations) {
      if (rel.alias) names.push(rel.alias);
      else if (rel.name) names.push(rel.name);
    }
    return names;
  },
  "names/unknown-column": columnsForQualifiedToken,
  "names/unqualified-column": (at, offset) => columnsForStatement(at, offset),
  "query/insert-unknown-column": (at, offset) => findInsertTarget(at, offset)?.table.columns.map((c) => c.name),
  "schema/fk-unknown-table": (at) => [...at.workspace.catalog.tables.values()].map((t) => t.name),
  "schema/fk-unknown-column": (at, offset) => columnsForFkColumn(at, offset),
  "schema/index-unknown-column": (at, offset) => columnsForIndexColumn(at, offset),
};

/**
 * "Did you mean X?" — a rename to the closest name in whatever set the reporting rule compared
 * against. Covers every rule that reports a name matching nothing: three catalog lookups
 * (`names/unknown-table`, `names/unknown-routine`, `schema/fk-unknown-table`), four column lookups
 * (`names/unknown-column`, `names/unqualified-column`, `schema/fk-unknown-column`,
 * `schema/index-unknown-column`), a statement's own declared aliases (`names/unknown-alias`), and
 * an insert target's columns (`query/insert-unknown-column`).
 */
function didYouMean(at: At, diagnostics: readonly Diagnostic[], out: CodeAction[]): void {
  for (const d of diagnostics) {
    const code = typeof d.code === "string" ? d.code : undefined;
    const build = code ? RENAME_CANDIDATES[code] : undefined;
    if (!build) continue;

    const offset = startOf(at, d);
    const found = tokenAt(at.lexed.tokens, offset);
    if (!found) continue;

    const candidates = build(at, offset, found.idx);
    if (!candidates) continue;

    const guess = nearest(found.token.v, candidates);
    if (!guess) continue;

    out.push(
      fix(
        `Rename to ${guess}`,
        at.document.uri,
        [{ range: rangeOf(lineIndex(at.text), found.token), newText: guess }],
        [d],
      ),
    );
  }
}

/** Words after `END` that close a statement rather than the enclosing block — the one thing a scan
 * for a block's `BEGIN` has to read correctly. Mirrors `routine/declare-after-statement`'s own set. */
const NOT_A_BLOCK_END: ReadonlySet<string> = new Set(["IF", "WHILE", "LOOP", "REPEAT", "CASE"]);

/**
 * The `DECLARE` statement a name at `nameSpan` sits in: where it starts and where its terminating
 * `;` is. Shared by every fix that has to delete or move a whole `DECLARE` — a variable's, a
 * cursor's — regardless of what else that `DECLARE` might also name.
 */
function declareStatementBounds(tokens: readonly Token[], nameSpan: Span): { from: number; to: number } | undefined {
  const nameIdx = tokens.findIndex((t) => t.s === nameSpan.s && t.e === nameSpan.e);
  if (nameIdx === -1) return undefined;

  let from = nameIdx;
  while (from > 0 && !kw(tokens[from], "DECLARE")) {
    if (punct(tokens[from], ";")) return undefined;
    from--;
  }
  if (!kw(tokens[from], "DECLARE")) return undefined;

  let to = nameIdx;
  let depth = 0;
  while (to < tokens.length) {
    const t = tokens[to]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && punct(t, ";")) break;
    to++;
  }
  if (to >= tokens.length) return undefined;

  return { from, to };
}

/**
 * The same bounds, plus the span of every name the `DECLARE` lists before its type.
 *
 * A `DECLARE` can name several variables at once, all sharing one type and one `DEFAULT` —
 * `DECLARE a, b, c INT DEFAULT 0;` — and MySQL's grammar puts every name before the type,
 * comma-separated. That is read directly rather than guessed at from a comma count, so the type
 * itself (`DECIMAL(10,2)`, with its own comma inside parens) is never mistaken for a sibling name.
 * A cursor's `DECLARE` never has more than one name in it, so only the variable fix needs this.
 */
function declareBounds(tokens: readonly Token[], nameSpan: Span): { from: number; to: number; names: Span[] } | undefined {
  const bounds = declareStatementBounds(tokens, nameSpan);
  if (!bounds) return undefined;

  const names: Span[] = [];
  let i = bounds.from + 1;
  while (tokens[i]?.t === "id") {
    names.push({ s: tokens[i]!.s, e: tokens[i]!.e });
    if (!punct(tokens[i + 1], ",")) break;
    i += 2;
  }
  if (names.length === 0) return undefined;

  return { from: bounds.from, to: bounds.to, names };
}

/** The range to delete a whole `DECLARE ... ;`, its own leading indentation and trailing newline
 * included so removing it does not leave a blank line behind. */
function declareStatementRange(at: At, from: number, to: number): Range {
  const tokens = at.lexed.tokens;
  let start = tokens[from]!.s;
  while (start > 0 && (at.text[start - 1] === " " || at.text[start - 1] === "\t")) start--;

  let end = tokens[to]!.e;
  if (at.text[end] === "\n") end++;

  return rangeOf(lineIndex(at.text), { s: start, e: end });
}

/**
 * `routine/unused-variable`: delete the variable.
 *
 * Alone in its `DECLARE`, the whole statement goes. Named alongside others, only its own name and
 * one adjacent comma do — the one before it if it is last in the list, the one after it (and the
 * name's own leading comma, if any come before it in turn) otherwise — so `DECLARE a, b, c INT;`
 * loses exactly `a, `, `b, ` or `, c` depending on which of the three is unused, and the type and
 * `DEFAULT` stay shared by whichever names remain.
 */
function unusedVariableFix(at: At, local: Local, d: Diagnostic, out: CodeAction[]): void {
  const bounds = declareBounds(at.lexed.tokens, local.nameSpan);
  if (!bounds) return;

  const pos = bounds.names.findIndex((span) => span.s === local.nameSpan.s && span.e === local.nameSpan.e);
  if (pos === -1) return;

  let range: Range;
  if (bounds.names.length === 1) {
    range = declareStatementRange(at, bounds.from, bounds.to);
  } else if (pos < bounds.names.length - 1) {
    // Not last: take this name and everything up to the next one, comma and its own space included.
    range = rangeOf(lineIndex(at.text), { s: bounds.names[pos]!.s, e: bounds.names[pos + 1]!.s });
  } else {
    // Last: take the comma before it instead, through this name's own end.
    range = rangeOf(lineIndex(at.text), { s: bounds.names[pos - 1]!.e, e: bounds.names[pos]!.e });
  }

  out.push(fix(`Remove unused variable ${local.name}`, at.document.uri, [{ range, newText: "" }], [d]));
}

/**
 * `routine/cursor-never-opened`: delete the whole `DECLARE ... CURSOR FOR ...;`.
 *
 * A cursor is declared one to a `DECLARE` — unlike a variable, MySQL's grammar gives it no
 * comma-separated sibling form — so there is no partial case to handle, only the whole statement.
 */
function cursorNeverOpenedFix(at: At, local: Local, d: Diagnostic, out: CodeAction[]): void {
  const bounds = declareStatementBounds(at.lexed.tokens, local.nameSpan);
  if (!bounds) return;

  const range = declareStatementRange(at, bounds.from, bounds.to);
  out.push(fix(`Remove cursor ${local.name}`, at.document.uri, [{ range, newText: "" }], [d]));
}

/**
 * `routine/declare-after-statement`: move the `DECLARE` to the top of its enclosing block.
 *
 * Inserted right after the block's own `BEGIN`. MySQL only requires every `DECLARE` to come before
 * the block's first statement, not that several of them stay in any particular relative order, so
 * this is a correct fix for one offender at a time even without tracking where earlier ones landed.
 */
function declareReorderFix(at: At, offset: number, d: Diagnostic, out: CodeAction[]): void {
  const tokens = at.lexed.tokens;
  const found = tokenAt(tokens, offset);
  if (!found || !kw(found.token, "DECLARE")) return;
  const declareIdx = found.idx;

  // The terminating `;` — refusing a `DECLARE ... HANDLER FOR ... BEGIN ... END` in between, which
  // is a different grammatical shape a plain scan should not walk into.
  let to = declareIdx;
  let depth = 0;
  let handler = false;
  while (to < tokens.length) {
    const t = tokens[to]!;
    if (kw(t, "BEGIN")) handler = true;
    else if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && punct(t, ";")) break;
    to++;
  }
  if (to >= tokens.length || handler) return;

  // The enclosing block's `BEGIN`, with the same block-depth tracking the rule itself uses.
  let blocks = 0;
  let beginIdx = -1;
  for (let i = declareIdx - 1; i >= 0; i--) {
    if (kw(tokens[i], "END") && kwAny(tokens[i + 1], NOT_A_BLOCK_END) === undefined) {
      blocks++;
    } else if (kw(tokens[i], "BEGIN")) {
      if (blocks === 0) {
        beginIdx = i;
        break;
      }
      blocks--;
    }
  }
  if (beginIdx === -1) return;

  const starts = lineIndex(at.text);
  const declareStart = tokens[declareIdx]!.s;
  const declareText = at.text.slice(declareStart, tokens[to]!.e);

  let removeStart = declareStart;
  while (removeStart > 0 && (at.text[removeStart - 1] === " " || at.text[removeStart - 1] === "\t")) removeStart--;
  const indent = at.text.slice(removeStart, declareStart);

  let removeEnd = tokens[to]!.e;
  if (at.text[removeEnd] === "\n") removeEnd++;

  const beginEnd = tokens[beginIdx]!.e;
  const edits: TextEdit[] = [
    { range: rangeOf(starts, { s: removeStart, e: removeEnd }), newText: "" },
    { range: rangeOf(starts, { s: beginEnd, e: beginEnd }), newText: `\n${indent}${declareText}` },
  ];
  out.push(fix(`Move this DECLARE above the block's first statement`, at.document.uri, edits, [d]));
}

/** The range to delete an `Index`'s whole clause, plus one adjacent comma so the surrounding
 * column-definition list stays well formed. */
function removeClauseEdit(text: string, span: Span): TextEdit | undefined {
  let start = span.s;
  let end = span.e;

  let i = end;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] === ",") {
    // The common case: another clause follows, and its own comma is this one's to take. The
    // clause's own leading indentation, and the newline before it, go too — otherwise deleting a
    // whole line leaves a blank one behind.
    end = i + 1;
    let j = start;
    while (j > 0 && (text[j - 1] === " " || text[j - 1] === "\t")) j--;
    if (text[j - 1] === "\n") start = j - 1;
  } else {
    let j = start - 1;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    if (text[j] === ",") start = j;
    // Neither side has a comma: this is the list's only clause, and there is nothing safe to do.
    else return undefined;
  }

  return { range: rangeOf(lineIndex(text), { s: start, e: end }), newText: "" };
}

/** `schema/redundant-index`: delete the redundant index's own clause. */
function redundantIndexFix(at: At, offset: number, d: Diagnostic, out: CodeAction[]): void {
  const parsed = parseDDL(at.workspace.dialect, at.text, at.lexed);
  for (const table of parsed.tables) {
    for (const index of table.indexes) {
      if (!index.span || offset < index.span.s || offset > index.span.e) continue;
      const edit = removeClauseEdit(at.text, index.span);
      if (!edit) return;
      out.push(fix(`Remove ${index.name ?? "this index"}`, at.document.uri, [edit], [d]));
      return;
    }
  }
}

/**
 * A table re-parsed from its own file, for accurate offsets in that file.
 *
 * The live buffer's text when that file is the one already open — an edit must never target a
 * version of the file the editor no longer shows — and disk otherwise, the same reasoning
 * `resolveTwin` (above) applies to an audit twin's file.
 */
function freshTable(at: At, file: string, name: string): { src: string; lexed: Lexed; table: Table } | undefined {
  const src = file === at.path ? at.text : at.workspace.catalog.read(file);
  if (src === undefined) return undefined;

  const lexed = file === at.path ? at.lexed : tokenize(src);
  const fold = (n: string): string => at.workspace.dialect.foldIdentifier(n, false);
  const table = parseDDL(at.workspace.dialect, src, lexed).tables.find((t) => fold(t.name) === fold(name));
  return table ? { src, lexed, table } : undefined;
}

/**
 * `schema/fk-missing-index`: add an index on the **referenced** table, over the referenced
 * columns — the one InnoDB needs to check the constraint without scanning. Added to that table's
 * own file, which is not necessarily the one the diagnostic sits in.
 */
function fkMissingIndexFix(at: At, offset: number, d: Diagnostic, out: CodeAction[]): void {
  const table = tableAt(at, offset);
  if (!table) return;

  for (const fk of table.foreignKeys) {
    if (!fk.refTableSpan || offset < fk.refTableSpan.s || offset >= fk.refTableSpan.e) continue;
    if (!fk.refTable || fk.refColumns.length === 0) return;

    const catalogued = at.workspace.catalog.table(fk.refTable);
    if (!catalogued?.file) return;

    const found = freshTable(at, catalogued.file, catalogued.name);
    if (!found) return;
    const { src, lexed, table: target } = found;

    const fold = (name: string): string => at.workspace.dialect.foldIdentifier(name, false);
    // The target's own spelling of each column, not the FK's — they can be quoted differently, and
    // generated DDL should read the way the file that receives it already does.
    const columns = fk.refColumns.map((name) => target.byName.get(fold(name))?.name);
    if (columns.some((name) => name === undefined)) return;

    const indexName = `ix_${columns.map((name) => name!.toLowerCase()).join("_")}`;
    if (target.indexes.some((idx) => idx.name && fold(idx.name) === fold(indexName))) return;

    const tokens = lexed.tokens;
    let i = tokens.findIndex((t) => t.s === target.nameSpan.s && t.e === target.nameSpan.e);
    if (i === -1) return;
    while (i < tokens.length && !punct(tokens[i], "(")) i++;
    const close = matchingParen(tokens, i);
    if (close === -1 || close - 1 <= i) return;

    // Right after the last existing definition's own end, not right before the closing paren: the
    // paren sits on its own line, and the comma has to lead the new clause rather than trail the
    // old one, the same reasoning `auditColumnFix`'s insertion comment gives.
    const insertAt = tokens[close - 1]!.e;
    const edit: TextEdit = {
      range: rangeOf(lineIndex(src), { s: insertAt, e: insertAt }),
      newText: `,\n  KEY ${indexName} (${columns.join(", ")})`,
    };
    out.push(fix(`Add an index on ${target.name} (${columns.join(", ")})`, uriOf(catalogued.file), [edit], [d]));
    return;
  }
}

/** `routine/unused-variable`, `routine/cursor-never-opened`, `routine/declare-after-statement`,
 * `schema/redundant-index`, `schema/fk-missing-index`: fixes that do not need a candidate set,
 * just the finding's own location read back out of the tokens. */
function structuralQuickFixes(at: At, diagnostics: readonly Diagnostic[], out: CodeAction[]): void {
  for (const d of diagnostics) {
    const offset = startOf(at, d);
    if (d.code === "routine/unused-variable") {
      const { scope } = contextAt(at, offset);
      const local = scope.items.find((item) => item.kind === "variable" && item.nameSpan.s === offset);
      if (local) unusedVariableFix(at, local, d, out);
    } else if (d.code === "routine/cursor-never-opened") {
      const { scope } = contextAt(at, offset);
      const local = scope.items.find((item) => item.kind === "cursor" && item.nameSpan.s === offset);
      if (local) cursorNeverOpenedFix(at, local, d, out);
    } else if (d.code === "routine/declare-after-statement") {
      declareReorderFix(at, offset, d, out);
    } else if (d.code === "schema/redundant-index") {
      redundantIndexFix(at, offset, d, out);
    } else if (d.code === "schema/fk-missing-index") {
      fkMissingIndexFix(at, offset, d, out);
    }
  }
}

/** `query/insert-value-count`: complete an under-supplied `VALUES` tuple with markers for the
 * slots it is missing. A tuple with *too many* values gets no fix — which of them is wrong is not
 * knowable — and neither does a positional insert into a table with generated columns, where the
 * rule itself accepts two different counts and completing to one of them would be a guess. */
function insertValueCountFix(at: At, offset: number, d: Diagnostic, out: CodeAction[]): void {
  const target = findInsertTarget(at, offset);
  if (!target) return;

  const dialect = at.workspace.dialect;
  let expected: number;
  let columns: Column[];
  if (target.list) {
    columns = target.list.names
      .map((name) => target.table.byName.get(dialect.foldIdentifier(name, false)))
      .filter((c): c is Column => c !== undefined);
    expected = target.list.names.length;
    if (columns.length !== expected) return; // an unknown-column list is a different rule's finding
  } else {
    if (target.table.columns.some((c) => c.generated)) return; // two accepted counts: ambiguous
    columns = target.table.columns;
    expected = columns.length;
  }

  const found = tokenAt(at.lexed.tokens, offset);
  if (!found || !punct(found.token, "(")) return;
  const given = arity(at.lexed.tokens, found.idx);
  if (!given || given.count >= expected) return;

  const insertPos = at.lexed.tokens[given.close]!.s;
  const edit: TextEdit = {
    range: rangeOf(lineIndex(at.text), { s: insertPos, e: insertPos }),
    newText: `, ${markers(columns.slice(given.count))}`,
  };
  out.push(fix(`Add ${expected - given.count} missing value(s)`, at.document.uri, [edit], [d]));
}

/** `query/insert-missing-required-column`: append the missing columns to the column list, and a
 * marker for each to every `VALUES` tuple. Only for the `VALUES` form — there is no mechanical
 * value to add to a `SELECT` list. */
function insertMissingColumnFix(at: At, offset: number, d: Diagnostic, out: CodeAction[]): void {
  const target = findInsertTarget(at, offset);
  if (!target?.list) return;

  const tokens = at.lexed.tokens;
  let j = target.after;
  if (!kw(tokens[j], "VALUES") && !kw(tokens[j], "VALUE")) return;
  j++;

  const dialect = at.workspace.dialect;
  const given = new Set(target.list.names.map((name) => dialect.foldIdentifier(name, false)));
  const missing = target.table.columns.filter((c) => {
    if (c.nullable || c.autoIncrement || c.generated || c.default !== undefined) return false;
    if (c.type.name === "timestamp") return false;
    return !given.has(dialect.foldIdentifier(c.name, c.quoted));
  });
  if (missing.length === 0) return;

  const starts = lineIndex(at.text);
  const listEnd = tokens[target.list.to]!.s;
  const edits: TextEdit[] = [
    { range: rangeOf(starts, { s: listEnd, e: listEnd }), newText: `, ${missing.map((c) => c.name).join(", ")}` },
  ];

  const columnMarkers = markers(missing);
  while (punct(tokens[j], "(")) {
    const close = matchingParen(tokens, j);
    if (close === -1) break;
    const pos = tokens[close]!.s;
    edits.push({ range: rangeOf(starts, { s: pos, e: pos }), newText: `, ${columnMarkers}` });
    j = close + 1;
    if (punct(tokens[j], ",")) j++;
    else break;
  }

  out.push(fix(`Add ${missing.map((c) => c.name).join(", ")} to the INSERT`, at.document.uri, edits, [d]));
}

/** `query/insert-value-count`, `query/insert-missing-required-column`. `query/insert-select-column-count`
 * gets no fix: its own docs describe the real cause as a scalar prefix falling out of step with a
 * trailing `t.*`, and there is no way to tell whether the right edit adds scalars, removes them, or
 * changes the star's table — exactly the guess the rest of this file declines to make. */
function insertQuickFixes(at: At, diagnostics: readonly Diagnostic[], out: CodeAction[]): void {
  for (const d of diagnostics) {
    const offset = startOf(at, d);
    if (d.code === "query/insert-value-count") insertValueCountFix(at, offset, d, out);
    else if (d.code === "query/insert-missing-required-column") insertMissingColumnFix(at, offset, d, out);
  }
}

/** The actions available at a position, plus the quick fixes anchored to whichever diagnostics the
 * client says overlap the request. */
export function codeActions(at: At, diagnostics: readonly Diagnostic[] = []): CodeAction[] {
  const out: CodeAction[] = [];
  expandStar(at, out);
  generateStatements(at, out);
  // Only a file that defines a table can be out of step with that table's twin.
  if (DDL.test(at.text)) synchroniseAudit(at, diagnostics, out);

  if (diagnostics.length > 0) {
    didYouMean(at, diagnostics, out);
    structuralQuickFixes(at, diagnostics, out);
    insertQuickFixes(at, diagnostics, out);
  }

  return out;
}
