/**
 * What a column is allowed to hold.
 *
 * Schemas that predate `ENUM`, or distrust it, use `char(1)` as one: a column holding `'A'`,
 * `'B'`, `'P'` and nothing else. Writing `WHERE status = '` and having to go and read the table
 * to remember which letters are legal is the gap this closes.
 *
 * Two sources, and they say different things:
 *
 *   - **The `COMMENT`**, which is authoritative: the author wrote down the whole set with a
 *     meaning for each code. Rare, because writing it is optional and nobody is made to.
 *   - **The literals the stored procedures compare against**, which cover most columns but are a
 *     *lower bound*. A value no procedure mentions is still legal, so this source can say "these
 *     have been used", never "these are the only ones".
 *
 * The module does no I/O and knows nothing about LSP.
 */

import type { Dialect } from "../dialects/dialect.ts";
import type { Column, Table } from "../model/table.ts";
import { tokenize } from "../syntax/fast/lexer.ts";
import { relations, statements } from "../syntax/fast/stmt.ts";
import { kw, matchingParen, punct, unquote } from "../syntax/fast/tok.ts";

export interface ColumnValue {
  /** The literal itself. */
  code: string;
  /** What it means, when the comment says. */
  label?: string;
}

/**
 * Does this column behave like an enum?
 *
 * Fixed-width text of one or two characters. A `varchar` is not included: that is where free text
 * lives, and offering "values seen in the code" for a name field would be nonsense.
 */
export function isEnumLike(column: Column | undefined): boolean {
  if (!column) return false;
  const t = column.type.raw.toLowerCase();
  return t.startsWith("char(1)") || t.startsWith("char(2)");
}

/**
 * A one-character word, followed by `:` or `=` and then the label, up to the next separator.
 *
 * The code must be a **one-character word** or the prose introducing the list is mistaken for an
 * option: `'Order source: A=App, W=Web'` would yield `e = "A=App"`, because "source" ends in `e`
 * and a colon follows. The character classes are spelled out rather than using `\w` and `\s`,
 * which would also match `_` and every Unicode space and quietly change the boundary.
 */
const OPTION = /(?<![A-Za-z0-9])([A-Za-z0-9])(?![A-Za-z0-9])[ \t\n\v\f\r]*[:=][ \t\n\v\f\r]*([^,;]+)/g;

/** Reads `A: Active, C: Cancelled` or `A=App, W=Web` out of a `COMMENT`. */
export function fromComment(comment: string | undefined): ColumnValue[] | undefined {
  if (comment === undefined) return undefined;

  const out: ColumnValue[] = [];
  for (const [, code, rest] of comment.matchAll(OPTION)) {
    const label = rest!.replace(/^[ \t\n\v\f\r]+/, "").replace(/[ \t\n\v\f\r]+$/, "");
    // A long label is prose that happens to contain an `=`, not an option. The 60 are counted in
    // characters and not in bytes, which is what the threshold is reaching for — an accented
    // label is not longer prose for having accents.
    if (label.length > 0 && label.length <= 60) out.push({ code: code!, label });
  }

  // One option is not a set; it is a sentence with a colon in it.
  return out.length >= 2 ? out : undefined;
}

/** Accumulator: literals seen per column, keyed `table.column` folded. */
export type ValueAccumulator = Map<string, Set<string>>;

/**
 * Gathers, from one source, the literals its statements compare enum-like columns against.
 *
 * A column is attributed only when there is no doubt whose it is: qualified by an alias that
 * resolves, or bare in a statement where exactly **one** relation has that name. Attributing an
 * ambiguous one would pollute both tables, and the ambiguity rule says that reference is a bug
 * anyway.
 */
export function collect(
  dialect: Dialect,
  src: string,
  lookup: (name: string) => Table | undefined,
  out: ValueAccumulator,
): void {
  const tokens = tokenize(src).tokens;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  const record = (table: Table, columnName: string, literal: string): void => {
    const column = table.byName.get(fold(columnName));
    if (!isEnumLike(column)) return;
    // A literal wider than the column cannot be one of its values.
    if (literal.length > 2) return;
    const key = `${fold(table.name)}.${fold(column!.name)}`;
    let set = out.get(key);
    if (!set) out.set(key, (set = new Set()));
    set.add(literal);
  };

  for (const statement of statements(tokens)) {
    const byAlias = new Map<string, Table>();
    const present: Table[] = [];
    for (const relation of relations(dialect, tokens, statement.from, statement.to)) {
      const table = relation.name ? lookup(relation.name) : undefined;
      if (table) {
        byAlias.set(fold(relation.alias ?? relation.name!), table);
        byAlias.set(fold(relation.name!), table);
        present.push(table);
      }
    }
    if (present.length === 0) continue;

    for (let i = statement.from; i <= statement.to; i++) {
      const t = tokens[i]!;
      if (t.t !== "id") continue;

      let owner: Table | undefined;
      const qualifier = tokens[i - 2];
      if (punct(tokens[i - 1], ".") && qualifier && qualifier.t === "id") {
        owner = byAlias.get(fold(qualifier.v));
      } else {
        let hits = 0;
        for (const table of present) {
          if (table.byName.has(fold(t.v))) {
            owner = table;
            hits++;
          }
        }
        if (hits !== 1) owner = undefined;
      }
      if (!owner) continue;

      // `Col = 'A'`, and its negations, which name a legal value just as well.
      const operator = tokens[i + 1];
      const literal = tokens[i + 2];
      if (
        operator &&
        operator.t === "punct" &&
        (operator.v === "=" || operator.v === "!=" || operator.v === "<>") &&
        literal &&
        literal.t === "str"
      ) {
        record(owner, t.v, unquote(literal.v));
      }

      // `Col IN ('A', 'S')`, and `NOT IN`, likewise.
      let inIdx = i + 1;
      if (kw(tokens[inIdx], "NOT")) inIdx++;
      if (kw(tokens[inIdx], "IN") && punct(tokens[inIdx + 1], "(")) {
        const close = matchingParen(tokens, inIdx + 1);
        if (close !== -1) {
          for (let k = inIdx + 2; k <= close - 1; k++) {
            if (tokens[k]!.t === "str") record(owner, t.v, unquote(tokens[k]!.v));
          }
        }
      }
    }
  }
}

/** Turns the accumulator into a sorted list per column. */
export function finish(gathered: ValueAccumulator): Map<string, ColumnValue[]> {
  const out = new Map<string, ColumnValue[]>();
  for (const [key, set] of gathered) {
    out.set(
      key,
      [...set].sort().map((code) => ({ code })),
    );
  }
  return out;
}
