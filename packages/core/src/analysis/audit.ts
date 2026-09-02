/**
 * Keeping an `aud_X` table and its triggers in step with `X`.
 *
 * Where a schema follows the convention that a table `X` is mirrored by an `aud_X` carrying an
 * audit prefix plus **all** of `X`'s columns, and triggers that insert positionally, adding a
 * column to `X` and forgetting the other two is silent: nothing fails, the field just stops being
 * recorded. `audit/table-out-of-sync` and `audit/trigger-missing-column` report it; this works out
 * the edit that fixes it.
 *
 * It is the convention itself plus the arithmetic of the repair, and it does no I/O: it takes two
 * parsed tables and returns offsets and text. What that becomes — a code action, a command, a
 * patch — is the caller's problem. That is why it lives beside the rest of the analysis rather than
 * under `rules/`, which is only one of its two consumers.
 *
 * ## What the generated definition looks like, and why
 *
 * Measured over a real audited schema: of the mirrored columns, seven in eight are byte-identical
 * to their source and the rest differ. The differences are almost all `NOT NULL` relaxed to
 * `DEFAULT NULL`, which reads as drift rather than as a rule, so the definition is copied
 * **verbatim**.
 *
 * The one transformation that *is* a rule is dropping `AUTO_INCREMENT`: of the audited tables with
 * an auto-increment column, not one keeps it in the twin, which is right — the `aud_` table has its
 * own key, and MySQL allows exactly one auto-increment column per table.
 */

import type { Dialect } from "../dialects/dialect.ts";
import type { Column, Table, Trigger, TriggerAudit } from "../model/table.ts";
import { kw, matchingParen, punct, splitCommas } from "../syntax/fast/tok.ts";
import type { Span, Token, TokenRange } from "../syntax/types.ts";

/** The prefix the convention puts on an audit table. */
export const AUDIT_PREFIX = "aud_";

/** The name a table's twin would have. */
export function auditTableName(table: string): string {
  return AUDIT_PREFIX + table;
}

/**
 * A column definition as the twin should carry it.
 *
 * The `aud_` table already has an auto-increment key of its own and MySQL allows exactly one, so
 * carrying the source's over would make the generated DDL invalid rather than merely odd.
 */
export function auditDefinition(definition: string): string {
  return definition.replace(/\s+auto_increment/gi, "");
}

/**
 * Reads a trigger body for the two facts the audit rules need.
 *
 * The triggers insert positionally, so a column is audited exactly when it appears as `NEW.col` or
 * `OLD.col` somewhere in the body. `NEW` and `OLD` are collected together on purpose: an
 * `AFTER UPDATE` trigger writes two rows, the before state with `OLD.` and the after with `NEW.`,
 * and either mention proves the column is carried.
 *
 * `writesAudit` is the guard that makes any of it mean something. Without it the question reads as
 * "does this trigger mention every column", which is nonsense for a trigger that exists to enforce a
 * business rule.
 *
 * It lives here, and is stored on the `Trigger` by the catalog, because the two rules that need it
 * stand in different places: one is handed the trigger's own tokens, and the other is looking at a
 * table and cannot see any trigger's body at all. Two implementations of the same question would
 * eventually disagree, and the pair of rules only works while they agree.
 */
export function triggerAudit(dialect: Dialect, tokens: readonly Token[], trigger: Trigger): TriggerAudit {
  const target = dialect.foldIdentifier(auditTableName(trigger.table), false);
  const columns = new Set<string>();
  let writesAudit = false;

  for (let i = trigger.body.from; i <= trigger.body.to; i++) {
    const t = tokens[i];
    if (!t) break;
    if (t.t === "punct" && t.v === ".") {
      const qualifier = tokens[i - 1];
      const name = tokens[i + 1];
      if (qualifier && name?.t === "id") {
        const which = qualifier.v.toUpperCase();
        if (which === "NEW" || which === "OLD") columns.add(dialect.foldIdentifier(name.v, name.q ?? false));
      }
    } else if (kw(t, "INTO")) {
      const into = tokens[i + 1];
      if (into && dialect.foldIdentifier(into.v, into.q ?? false) === target) writesAudit = true;
    }
  }

  return { columns, writesAudit };
}

/** Columns of `X` that `aud_X` does not carry, in `X`'s own order. */
export function missingColumns(dialect: Dialect, table: Table, audit: Table): Column[] {
  return table.columns.filter((column) => !audit.byName.has(dialect.foldIdentifier(column.name, column.quoted)));
}

/**
 * How many of `aud_X`'s leading columns are the audit prefix rather than mirrored ones.
 *
 * Derived rather than listed — the prefix is whatever the twin has that the table does not — so a
 * schema is free to call its bookkeeping columns whatever it likes without configuring anything.
 */
export function prefixCount(dialect: Dialect, table: Table, audit: Table): number {
  let n = 0;
  for (const column of audit.columns) {
    if (table.byName.has(dialect.foldIdentifier(column.name, column.quoted))) break;
    n++;
  }
  return n;
}

/** Where a group of missing columns goes, and which ones go there. */
export interface Insertion {
  /** Offset to insert at: one past the end of the definition it follows. */
  after: number;
  columns: Column[];
}

/**
 * Where each missing column has to go inside `aud_X`'s `CREATE TABLE`.
 *
 * Position is not cosmetic here: the triggers insert **positionally**, so a column appended at the
 * end would be filled with the wrong value. The anchor is the `aud_` column that precedes it once
 * the two tables are lined up — the previous mirrored column, or the last of the audit prefix when
 * the missing one comes first.
 */
export function insertions(dialect: Dialect, table: Table, audit: Table): Insertion[] {
  const fold = (column: Column): string => dialect.foldIdentifier(column.name, column.quoted);

  let anchor: number | undefined;
  for (const column of audit.columns) {
    if (table.byName.has(fold(column))) break;
    anchor = column.definitionSpan.e;
  }

  const groups = new Map<number, Column[]>();
  for (const column of table.columns) {
    const twin = audit.byName.get(fold(column));
    if (twin) {
      anchor = twin.definitionSpan.e;
    } else if (anchor !== undefined) {
      // Insertion order is the map's iteration order, which is the order the columns appear in the
      // table — the order the twin has to end up in.
      let group = groups.get(anchor);
      if (!group) groups.set(anchor, (group = []));
      group.push(column);
    }
  }

  return [...groups].map(([after, columns]) => ({ after, columns }));
}

/** A value list to replace, and what it should say. */
export interface AuditInsert extends Span {
  text: string;
}

/**
 * Locates each `INSERT INTO aud_X VALUES (…)` in a trigger body and works out the value list it
 * should carry.
 *
 * Only the slots **after the audit prefix** are rewritten. The prefix ones are `0`, `NOW()`,
 * `SUBSTRING_INDEX(USER(),'@',1)` and the like, which say nothing about the table's columns and
 * must survive untouched. Which of `NEW.` or `OLD.` to use is read off the slots being replaced,
 * since the `AFTER UPDATE` trigger writes one row of each.
 *
 * @param body The trigger's token range.
 * @param prefix How many leading columns of the twin are the audit prefix.
 */
export function triggerInserts(
  dialect: Dialect,
  tokens: readonly Token[],
  body: TokenRange,
  table: Table,
  auditName: string,
  prefix: number,
): AuditInsert[] {
  const target = dialect.foldIdentifier(auditName, false);
  const out: AuditInsert[] = [];

  for (let i = body.from; i <= body.to; i++) {
    if (!kw(tokens[i], "INSERT") || !kw(tokens[i + 1], "INTO")) continue;
    const into = tokens[i + 2];
    if (!into || into.t !== "id" || dialect.foldIdentifier(into.v, into.q ?? false) !== target) continue;

    let open = i + 3;
    if (kw(tokens[open], "VALUES")) open++;
    if (!punct(tokens[open], "(")) continue;

    const close = matchingParen(tokens, open);
    if (close < 0) continue;

    const slots = splitCommas(tokens, open + 1, close - 1);
    if (slots.length <= prefix) continue;

    // `NEW` or `OLD`, taken from the first slot being replaced. An `INSERT` naming its columns
    // rather than inserting positionally has an identifier here that is neither, and is left alone.
    const first = slots[prefix]!;
    const marker = tokens[first.from];
    const qualifier = marker?.t === "id" ? marker.v.toUpperCase() : undefined;
    if (qualifier !== "NEW" && qualifier !== "OLD") continue;

    out.push({
      s: tokens[first.from]!.s,
      e: tokens[slots[slots.length - 1]!.to]!.e,
      text: table.columns.map((column) => `${qualifier}.${column.name}`).join(", "),
    });
  }

  return out;
}
