/**
 * Which variables a `SELECT … INTO` filled from a column the catalog says is nullable.
 *
 * Both taint rules start here and neither is a place to keep a second copy: they would then disagree
 * about which variables are suspect, and a reader comparing two findings about the same variable
 * would have no way of telling which of them was right.
 */

import type { Table } from "../../model/table.ts";
import { relations } from "../../syntax/fast/stmt.ts";
import { kw, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { DocumentContext } from "../rule.ts";

/**
 * The tainted variables, folded, each with the `Table.column` it came from.
 *
 * The `SELECT` list is matched against the `INTO` list **by position**, which is how MySQL assigns
 * them. A slot holding an expression, or a column from a relation that did not resolve, taints
 * nothing: a variable is only ever tainted from a column known to be nullable, never from a guess.
 */
export function nullableSources(ctx: DocumentContext): Map<string, string> {
  const tainted = new Map<string, string>();
  const { tokens, dialect } = ctx;

  for (const statement of ctx.statements()) {
    if (!kw(tokens[statement.from], "SELECT")) continue;

    // The `INTO` belonging to this `SELECT`, not to a subquery inside it.
    let into: number | undefined;
    let depth = 0;
    for (let i = statement.from; i <= statement.to; i++) {
      const t = tokens[i]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && kw(t, "INTO") && into === undefined) into = i;
    }
    if (into === undefined || into <= statement.from + 1) continue;

    const targets: string[] = [];
    let j = into + 1;
    while (tokens[j]?.t === "id") {
      targets.push(dialect.foldIdentifier(tokens[j]!.v, tokens[j]!.q ?? false));
      if (punct(tokens[j + 1], ",")) j += 2;
      else break;
    }

    const byAlias = new Map<string, Table>();
    for (const relation of relations(dialect, tokens, statement.from, statement.to)) {
      if (!relation.name) continue;
      const table = ctx.catalog.table(relation.name);
      if (!table) continue;
      byAlias.set(dialect.foldIdentifier(relation.alias ?? relation.name, false), table);
      byAlias.set(dialect.foldIdentifier(relation.name, relation.quoted === true), table);
    }

    splitCommas(tokens, statement.from + 1, into - 1).forEach((span, slot) => {
      const target = targets[slot];
      if (!target || !ctx.locals.byName.has(target)) return;

      let table: Table | undefined;
      let column: { name: string; nullable: boolean } | undefined;

      if (span.from === span.to && tokens[span.from]!.t === "id") {
        // A bare `col`: the one relation that has it, if exactly one does.
        const key = dialect.foldIdentifier(tokens[span.from]!.v, tokens[span.from]!.q ?? false);
        for (const candidate of byAlias.values()) {
          const hit = candidate.byName.get(key);
          if (hit) {
            table = candidate;
            column = hit;
            break;
          }
        }
      } else if (span.to === span.from + 2 && punct(tokens[span.from + 1], ".")) {
        table = byAlias.get(dialect.foldIdentifier(tokens[span.from]!.v, tokens[span.from]!.q ?? false));
        column = table?.byName.get(dialect.foldIdentifier(tokens[span.to]!.v, tokens[span.to]!.q ?? false));
      }

      if (table && column?.nullable) tainted.set(target, `${table.name}.${column.name}`);
    });
  }

  return tainted;
}
