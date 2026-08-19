/**
 * Extracts tables, columns, keys and triggers from a `.sql` file of DDL.
 */

import type { Dialect } from "../../dialects/dialect.ts";
import type { Column, Table, Trigger, TriggerEvent, TriggerTiming } from "../../model/table.ts";
import type { Lexed, Token } from "../types.ts";
import {
  columnList,
  kw,
  kwAny,
  matchingParen,
  objectAfterCreate,
  punct,
  qualifiedName,
  splitCommas,
  unquote,
} from "./tok.ts";
import { readType, typeExtent } from "./type.ts";

/** Leading words marking a definition as a constraint rather than a column. */
const CONSTRAINT_STARTERS: ReadonlySet<string> = new Set([
  "PRIMARY",
  "UNIQUE",
  "KEY",
  "INDEX",
  "CONSTRAINT",
  "FOREIGN",
  "CHECK",
  "FULLTEXT",
  "SPATIAL",
  "PERIOD",
]);

const TIMINGS: ReadonlySet<string> = new Set(["BEFORE", "AFTER"]);
const EVENTS: ReadonlySet<string> = new Set(["INSERT", "UPDATE", "DELETE"]);

/**
 * Reads the expression following a `DEFAULT`, which may be a single token (`NULL`, `0`, `'A'`),
 * a call (`CURRENT_TIMESTAMP(3)`), a parenthesis (`(json_object())`) or a literal with a charset
 * introducer (`_utf8mb4'A'`).
 *
 * @param i Index of the expression's first token.
 */
function readExpression(
  src: string,
  tokens: readonly Token[],
  i: number,
): { text: string | undefined; nextIdx: number } {
  const first = tokens[i];
  if (!first) return { text: undefined, nextIdx: i };

  let last = i;
  if (punct(first, "(")) {
    const close = matchingParen(tokens, i);
    last = close === -1 ? i : close;
  } else {
    // Charset introducer: `_utf8mb4` and the literal after it are one expression.
    const next = tokens[i + 1];
    if (first.t === "id" && first.v.startsWith("_") && next && next.t === "str") last = i + 1;
    if (punct(tokens[last + 1], "(")) {
      const close = matchingParen(tokens, last + 1);
      if (close !== -1) last = close;
    }
  }

  return { text: src.slice(first.s, tokens[last]!.e), nextIdx: last + 1 };
}

/** Parses a column definition: `` `Name` type [clauses...] ``. */
function parseColumn(src: string, tokens: readonly Token[], from: number, to: number): Column | undefined {
  const nameToken = tokens[from];
  if (!nameToken || nameToken.t !== "id") return undefined;

  const typeStart = from + 1;
  if (typeStart > to) return undefined;

  const typeEnd = typeExtent(tokens, typeStart, to);

  const column: Column = {
    name: nameToken.v,
    quoted: nameToken.q === true,
    type: readType(src, tokens, typeStart, typeEnd),
    nullable: true,
    autoIncrement: false,
    generated: false,
    definition: "",
    definitionSpan: { s: 0, e: 0 },
    // The token's end is stored rather than derived from the name's length: for a quoted name
    // those two differ, and the range would be off by the delimiters.
    nameSpan: { s: nameToken.s, e: nameToken.e },
  };

  let i = typeEnd + 1;
  while (i <= to) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (kw(t, "NOT") && kw(next, "NULL")) {
      column.nullable = false;
      i += 2;
    } else if (kw(t, "AUTO_INCREMENT")) {
      column.autoIncrement = true;
      i++;
    } else if (kw(t, "DEFAULT")) {
      const read = readExpression(src, tokens, i + 1);
      column.default = read.text;
      i = read.nextIdx;
    } else if (kw(t, "COLLATE") && next && next.t === "id") {
      column.collation = next.v;
      i += 2;
    } else if (kw(t, "CHARACTER") && kw(next, "SET")) {
      // `CHARACTER SET utf8mb4` on its own implies that charset's default collation. The name
      // is not resolved here — that would need MySQL's table of defaults — but skipping the
      // clause keeps it from being mistaken for anything else.
      i += 3;
    } else if (kw(t, "COMMENT") && next && next.t === "str") {
      column.comment = unquote(next.v);
      i += 2;
    } else if (kw(t, "GENERATED") || (kw(t, "AS") && punct(next, "("))) {
      // `GENERATED ALWAYS AS (expr) VIRTUAL`, or the short `AS (expr) STORED`. The expression
      // carries nested parentheses and strings (`json_extract(x, _utf8mb4'$.a')`), which the
      // balanced-paren skip handles on its own.
      column.generated = true;
      let open = i;
      while (open <= to && !punct(tokens[open], "(")) open++;
      const close = matchingParen(tokens, open);
      i = (close === -1 ? to : close) + 1;
    } else {
      i++;
    }
  }

  return column;
}

/** Applies a constraint (PK, index, FK) to the table's already-parsed columns. */
function applyConstraint(
  dialect: Dialect,
  table: Table,
  tokens: readonly Token[],
  from: number,
  to: number,
): void {
  let i = from;

  let constraintName: string | undefined;
  if (kw(tokens[i], "CONSTRAINT")) {
    const next = tokens[i + 1];
    if (next && next.t === "id" && !kw(next, "FOREIGN")) {
      constraintName = next.v;
      i += 2;
    } else {
      i++;
    }
  }

  const mark = (names: string[], quoted: boolean[], flag: "PRI" | "UNI" | "MUL"): void => {
    for (const [position, name] of names.entries()) {
      const column = table.byName.get(dialect.foldIdentifier(name, quoted[position] === true));
      // Rank only goes up: a column that is already PRI is not demoted to MUL just for also
      // being in a secondary index, which is how MySQL reports it.
      if (
        column &&
        (column.key === undefined || flag === "PRI" || (flag === "UNI" && column.key === "MUL"))
      ) {
        column.key = flag;
      }
    }
  };

  if (kw(tokens[i], "PRIMARY") && kw(tokens[i + 1], "KEY")) {
    const list = columnList(tokens, i + 2);
    table.primaryKey = list.names;
    table.primaryKeySpans = list.spans;
    mark(list.names, list.quoted, "PRI");
  } else if (kw(tokens[i], "FOREIGN") && kw(tokens[i + 1], "KEY")) {
    const list = columnList(tokens, i + 2);
    mark(list.names, list.quoted, "MUL");

    const j = (list.closeIdx === -1 ? i : list.closeIdx) + 1;
    if (kw(tokens[j], "REFERENCES")) {
      const ref = qualifiedName(tokens, j + 1);
      const refList = columnList(tokens, ref.nextIdx);
      table.foreignKeys.push({
        name: constraintName,
        columns: list.names,
        columnSpans: list.spans,
        refTable: ref.name,
        refTableSpan: ref.nameToken ? { s: ref.nameToken.s, e: ref.nameToken.e } : undefined,
        refColumns: refList.names,
        refColumnSpans: refList.spans,
      });
      // It is stored on the column too, so completion can show
      // `int NOT NULL → customers.user_id` without walking the FKs again.
      for (const [position, name] of list.names.entries()) {
        const column = table.byName.get(dialect.foldIdentifier(name, list.quoted[position] === true));
        const refColumn = refList.names[position];
        if (column && ref.name && refColumn) column.fk = { table: ref.name, column: refColumn };
      }
    }
  } else if (kw(tokens[i], "UNIQUE") || kw(tokens[i], "KEY") || kw(tokens[i], "INDEX")) {
    const unique = kw(tokens[i], "UNIQUE");
    // Skips the `KEY`/`INDEX` that may follow `UNIQUE`, and the index's optional name.
    let j = i + 1;
    if (kw(tokens[j], "KEY") || kw(tokens[j], "INDEX")) j++;
    let indexName: string | undefined;
    const nameToken = tokens[j];
    if (nameToken && nameToken.t === "id") {
      indexName = nameToken.v;
      j++;
    }

    if (punct(tokens[j], "(")) {
      const list = columnList(tokens, j);
      const span = list.closeIdx === -1 ? undefined : { s: tokens[i]!.s, e: tokens[list.closeIdx]!.e };
      table.indexes.push({ name: indexName, columns: list.names, columnSpans: list.spans, unique, span });
      mark(list.names, list.quoted, unique ? "UNI" : "MUL");
    }
  }
}

/**
 * Parses a `CREATE TABLE` starting at `createIdx`.
 *
 * @param tableIdx Index of the `TABLE` token.
 */
function parseCreateTable(
  dialect: Dialect,
  src: string,
  tokens: readonly Token[],
  createIdx: number,
  tableIdx: number,
): { table: Table | undefined; nextIdx: number } {
  const temporary = kw(tokens[tableIdx - 1], "TEMPORARY");

  let i = tableIdx + 1;
  if (kw(tokens[i], "IF") && kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS")) i += 3;

  const named = qualifiedName(tokens, i);
  if (named.name === undefined || !named.nameToken) return { table: undefined, nextIdx: tableIdx + 1 };

  if (!punct(tokens[named.nextIdx], "(")) return { table: undefined, nextIdx: named.nextIdx };
  const closeIdx = matchingParen(tokens, named.nextIdx);
  if (closeIdx === -1) return { table: undefined, nextIdx: named.nextIdx };

  const table: Table = {
    name: named.name,
    quoted: named.nameToken.q === true,
    schema: named.schema,
    columns: [],
    byName: new Map(),
    primaryKey: [],
    primaryKeySpans: [],
    indexes: [],
    foreignKeys: [],
    temporary,
    nameSpan: { s: named.nameToken.s, e: named.nameToken.e },
    range: { s: 0, e: 0 },
  };

  // Two passes: columns first, constraints second. The other way round, a `PRIMARY KEY`
  // declared before its columns (legal in MySQL) would find nothing to mark.
  const parts = splitCommas(tokens, named.nextIdx + 1, closeIdx - 1);
  const constraints: { from: number; to: number }[] = [];
  for (const part of parts) {
    if (kwAny(tokens[part.from], CONSTRAINT_STARTERS)) {
      constraints.push(part);
    } else {
      const column = parseColumn(src, tokens, part.from, part.to);
      if (column) {
        // The definition is kept verbatim: generating an `aud_` twin copies it as written. In a
        // repo that keeps audit tables, the overwhelming majority of audited columns are
        // byte-identical to their source, and the ones that differ are drift rather than a
        // convention worth reproducing.
        column.definitionSpan = { s: tokens[part.from]!.s, e: tokens[part.to]!.e };
        column.definition = src.slice(column.definitionSpan.s, column.definitionSpan.e);
        table.columns.push(column);
        table.byName.set(dialect.foldIdentifier(column.name, column.quoted), column);
      }
    }
  }
  for (const part of constraints) applyConstraint(dialect, table, tokens, part.from, part.to);

  // The statement runs to the `;` following the table options (`ENGINE=...`).
  let last = closeIdx;
  for (let j = closeIdx + 1; j <= Math.min(closeIdx + 64, tokens.length - 1); j++) {
    if (kw(tokens[j], "COLLATE")) {
      // `COLLATE=utf8mb4_unicode_ci`, the default every text column inherits.
      const at = punct(tokens[j + 1], "=") ? j + 2 : j + 1;
      const value = tokens[at];
      if (value && value.t === "id") table.collation = value.v;
    }
    if (punct(tokens[j], ";")) {
      last = j;
      break;
    }
    last = j;
  }
  table.range = { s: tokens[createIdx]!.s, e: tokens[last]!.e };

  // Text columns with no `COLLATE` of their own inherit the table's. `mysqldump` writes the
  // explicit one whenever it differs, so this rarely changes anything on generated DDL — but
  // hand-written DDL leans on the default, and a comparison between two columns has to see the
  // same collation MySQL would.
  if (table.collation !== undefined) {
    for (const column of table.columns) {
      if (column.collation === undefined && dialect.isTextType(column.type)) {
        column.collation = table.collation;
      }
    }
  }

  return { table, nextIdx: closeIdx + 1 };
}

/**
 * Parses a `CREATE TRIGGER` header, plus the token range its body spans.
 *
 * The body is bounded by the next `CREATE` rather than by matching the `BEGIN` with its `END`:
 * a body is full of `END IF` and `END WHILE` that close no block, and `CASE ... END` on top of
 * that, so counting them is a parser in itself. MySQL does not allow a `CREATE` inside a
 * trigger, which makes the next one an exact and much cheaper boundary.
 */
function parseCreateTrigger(
  tokens: readonly Token[],
  triggerIdx: number,
): { trigger: Trigger | undefined; nextIdx: number } {
  let i = triggerIdx + 1;
  if (kw(tokens[i], "IF") && kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS")) i += 3;

  const named = qualifiedName(tokens, i);
  if (named.name === undefined || !named.nameToken) return { trigger: undefined, nextIdx: triggerIdx + 1 };

  const timing = kwAny(tokens[named.nextIdx], TIMINGS) as TriggerTiming | undefined;
  const event = kwAny(tokens[named.nextIdx + 1], EVENTS) as TriggerEvent | undefined;
  if (!timing || !event || !kw(tokens[named.nextIdx + 2], "ON")) {
    return { trigger: undefined, nextIdx: named.nextIdx };
  }

  const target = qualifiedName(tokens, named.nextIdx + 3);
  if (target.name === undefined) return { trigger: undefined, nextIdx: named.nextIdx };

  let bodyEnd = tokens.length - 1;
  for (let j = target.nextIdx; j < tokens.length; j++) {
    if (kw(tokens[j], "CREATE")) {
      bodyEnd = j - 1;
      break;
    }
  }

  return {
    trigger: {
      name: named.name,
      quoted: named.nameToken.q === true,
      schema: named.schema,
      table: target.name,
      timing,
      event,
      nameSpan: { s: named.nameToken.s, e: named.nameToken.e },
      body: { from: target.nextIdx, to: bodyEnd },
    },
    nextIdx: target.nextIdx,
  };
}

export interface ParsedDDL {
  tables: Table[];
  triggers: Trigger[];
}

/**
 * Walks the token stream collecting every `CREATE TABLE` and every `CREATE TRIGGER`.
 *
 * A file may carry several of each: one table plus its audit triggers in the same `.sql` is a
 * common way to lay a schema out.
 */
export function parseDDL(dialect: Dialect, src: string, lexed: Lexed): ParsedDDL {
  const tokens = lexed.tokens;
  const tables: Table[] = [];
  const triggers: Trigger[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (kw(tokens[i], "CREATE")) {
      const { keyword, keywordIdx } = objectAfterCreate(tokens, i);
      if (keyword === "TABLE") {
        const parsed = parseCreateTable(dialect, src, tokens, i, keywordIdx);
        if (parsed.table) tables.push(parsed.table);
        i = parsed.nextIdx;
      } else if (keyword === "TRIGGER") {
        const parsed = parseCreateTrigger(tokens, keywordIdx);
        if (parsed.trigger) triggers.push(parsed.trigger);
        i = parsed.nextIdx;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return { tables, triggers };
}
