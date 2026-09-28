/**
 * What the schema looks like written down for a person.
 *
 * All the markdown lives here rather than in the features, for two reasons. The engine has no
 * business knowing about markdown — it produces a model, and a model that carried presentation
 * would have to be rewritten for every consumer that is not this one. And the same fragments are
 * wanted in more than one place: a column reads the same whether it arrives by hovering over it or
 * by picking it out of a completion list, and it would not stay that way if it were written twice.
 */

import type {
  BuiltinFunction,
  Column,
  JsonTableColumn,
  JsonTableColumns,
  Local,
  Resolved,
  Routine,
  Table,
  Trigger,
} from "@sqldex/core";
import { fromComment, isEnumLike } from "@sqldex/core";

import type { Workspace } from "./workspace.ts";

/** SQL, fenced, which is what makes a client colour it. */
export function sqlBlock(text: string): string {
  return "```sql\n" + text + "\n```";
}

/** Paragraphs, skipping the ones that turned out to have nothing in them. */
function joined(parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join("\n\n");
}

/**
 * The one line about a column that fits beside its name in a list.
 *
 * The foreign key is in it because "which table does this point at" is the question a column named
 * `customer_id` raises every single time, and the answer is not always the name.
 */
export function columnDetail(column: Column): string {
  const parts = [column.type.raw, column.nullable ? "NULL" : "NOT NULL"];
  if (column.key === "PRI") parts.push("PK");
  else if (column.key === "UNI") parts.push("UNIQUE");
  if (column.autoIncrement) parts.push("AUTO_INCREMENT");
  if (column.generated) parts.push("GENERATED");
  if (column.fk) parts.push(`→ ${column.fk.table}.${column.fk.column}`);
  return parts.join(" ");
}

/**
 * The values an enum-like column is allowed to hold, from whichever source knows.
 *
 * The two are worded differently on purpose. A `COMMENT` lists the whole set with a meaning for
 * each code, so it is stated as fact. What the procedures compare the column against is a **lower
 * bound** — a value nobody happens to mention is still legal — so it is stated as what has been
 * seen, and the difference matters to anyone about to write a `CHECK` from it.
 */
export function columnValues(workspace: Workspace, table: Table, column: Column): string | undefined {
  if (!isEnumLike(column)) return undefined;

  const documented = fromComment(column.comment);
  if (documented) {
    return "Values: " + documented.map((value) => `\`'${value.code}'\` ${value.label}`).join(" · ");
  }

  const fold = (name: string) => workspace.dialect.foldIdentifier(name, false);
  const observed = workspace.catalog.observedValues().get(`${fold(table.name)}.${fold(column.name)}`);
  if (!observed || observed.length === 0) return undefined;
  return "Seen holding: " + observed.map((value) => `\`'${value.code}'\``).join(", ");
}

export function columnDoc(workspace: Workspace, table: Table, column: Column): string {
  return joined([
    sqlBlock(`${table.name}.${column.name}  ${columnDetail(column)}`),
    column.default === undefined ? undefined : `DEFAULT \`${column.default}\``,
    column.comment,
    columnValues(workspace, table, column),
  ]);
}

/**
 * A temporary table, whether hovered by its own name or through an alias standing for it.
 *
 * `displayName` is what the hover is actually over — the temporary table's own name in the first
 * case, the alias in the second — and `viaAlias` picks the wording that says which one it was:
 * naming the table twice when nobody wrote it twice would be a worse answer than the question asked.
 */
export function tempTableDoc(resolved: Resolved, displayName: string, viaAlias: boolean, createdIn?: string): string {
  const columns = resolved.columns ?? [];
  const heading = viaAlias
    ? `${displayName}  — alias of temporary table ${resolved.name}, ${columns.length} columns`
    : `${resolved.name}  — temporary table, ${columns.length} columns`;
  const parts = [sqlBlock(heading)];
  if (columns.length > 0) parts.push(columns.join(", "));
  if (createdIn !== undefined) parts.push(`Created in \`${createdIn}\``);
  return parts.join("\n\n");
}

/**
 * A column of a temporary table, qualified or not — the same text either way, which is what makes
 * `tmp.doc` and a later bare `doc` agree about what they are.
 *
 * `origin` is the expression that computes the column, when this file's own `CREATE TEMPORARY
 * TABLE ... SELECT` could be read for it, or where the table was created otherwise; `undefined`
 * when the column is a plain reference to one that already existed and there is nothing more to
 * say about it.
 */
export function tempColumnDoc(tempName: string, columnName: string, origin?: string): string {
  const parts = [`\`${columnName}\` — column of temporary table \`${tempName}\``];
  if (origin !== undefined) parts.push(origin);
  return parts.join("\n\n");
}

/**
 * A `JSON_TABLE(...)` relation itself, hovered by its alias: the columns its own `COLUMNS(...)`
 * declares, plus where they come from — the same two facts `jsonTableColumnDoc` gives for one
 * column at a time.
 */
export function jsonTableDoc(alias: string, table: JsonTableColumns): string {
  const columns = table.columns.map((column) => column.name);
  const over = table.source !== undefined ? ` over \`${table.source}\`` : "";
  const rowPath = table.rootPath !== undefined ? ` (row path \`${table.rootPath}\`)` : "";
  const parts = [sqlBlock(`${alias}  — JSON_TABLE, ${columns.length} columns${over}${rowPath}`)];
  if (columns.length > 0) parts.push(columns.join(", "));
  return parts.join("\n\n");
}

/**
 * One column a `JSON_TABLE(...)` declares in its own `COLUMNS(...)` — reached from a qualified
 * reference (`j.doc`), an unqualified one, or a hover right on the declaration itself, since all
 * three are the same question about the same column.
 */
export function jsonTableColumnDoc(alias: string | undefined, column: JsonTableColumn, table: JsonTableColumns): string {
  const label = column.type === undefined ? column.name : `${column.name} ${column.type}`;
  const owner = alias === undefined ? "" : ` (alias \`${alias}\`)`;
  if (column.ordinality) {
    return `\`${label}\` — \`JSON_TABLE\` column${owner}, row number (FOR ORDINALITY)`;
  }
  const over = table.source !== undefined ? ` over \`${table.source}\`` : "";
  const rowPath = table.rootPath !== undefined ? ` (row path \`${table.rootPath}\`)` : "";
  return `\`${label}\` — \`JSON_TABLE\` column${owner}, path \`${column.path}\`${over}${rowPath}`;
}

/**
 * A table's documentation is its `CREATE TABLE`, exactly as the repository has it.
 *
 * Nothing is reformatted and nothing is summarised. The statement is the most precise answer there
 * is to every question a hover over a table name is really asking, and a rendering of it would only
 * be a worse copy that also has to be kept in step.
 */
export function tableDoc(workspace: Workspace, table: Table): string {
  const src = table.file === undefined ? undefined : workspace.catalog.read(table.file);
  if (src === undefined) return sqlBlock(table.name);
  return sqlBlock(src.slice(table.range.s, table.range.e));
}

export function routineDoc(routine: Routine): string {
  return joined([sqlBlock(routine.signature), routine.doc]);
}

export function triggerDoc(trigger: Trigger): string {
  return sqlBlock(`TRIGGER ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table}`);
}

export function builtinDoc(entry: BuiltinFunction): string {
  return joined([sqlBlock(entry.signature), entry.summary, `*MySQL ${entry.category} function*`]);
}

/** How a parameter, variable or cursor is described — the same words in hover and in a list. */
export function localDetail(item: Local): string {
  const kind = item.kind === "param" ? "parameter" : item.kind;
  return item.type === undefined ? kind : `${item.type.raw} ${kind}`;
}

/** The signature with the name sliced off, so a call's arguments line up in a completion list. */
export function argumentsOf(name: string, signature: string): string {
  return signature.startsWith(name) ? signature.slice(name.length) : signature;
}
