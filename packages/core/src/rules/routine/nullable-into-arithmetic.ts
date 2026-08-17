import type { Table } from "../../model/table.ts";
import { relations } from "../../syntax/fast/stmt.ts";
import { kw, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { DocumentContext } from "../rule.ts";
import type { Rule } from "../rule.ts";
import { ARITHMETIC, assignmentTargets, insideNullSafe } from "../support.ts";

/**
 * Which locals a `SELECT … INTO` filled from a column the catalog says is nullable, and where from.
 *
 * The `SELECT` list is matched against the `INTO` list **by position**, which is how MySQL assigns
 * them. A slot holding an expression, or a column from a relation that did not resolve, taints
 * nothing: a variable is only ever tainted from a column known to be nullable, never from a guess.
 */
function nullableSources(ctx: DocumentContext): Map<string, string> {
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

export const nullableIntoArithmetic: Rule = {
  id: "routine/nullable-into-arithmetic",
  group: "routine",
  severity: "warn",
  scope: "document",
  docs: `A nullable column reaching arithmetic through a variable.

The same defect as a nullable column entering an expression directly, with one hop added: the column
passes through a \`SELECT … INTO v\` first. The catalog knows the column is nullable, so the variable
inherits it — and then \`v * rate\` is NULL for the whole expression, with no error anywhere.

The \`SELECT\` list is matched to the \`INTO\` list **by position**, the way MySQL assigns them. A slot
holding an expression taints nothing, and neither does a column from a relation that did not resolve:
a variable is only ever tainted from a column the catalog says is nullable.

**What it does not model:** a later assignment from a source that cannot be NULL does not clear the
taint, because that needs the flow analysis \`routine/variable-never-assigned\` deliberately stops
short of. The exchange is worth naming — the rule can be wrong about a variable that was tainted and
then fixed, and in return it is never wrong about what tainted it.

A read wrapped in \`COALESCE\` / \`IFNULL\` / \`IF\` is not reported: that is the fix.`,

  check(ctx) {
    const tainted = nullableSources(ctx);
    if (tainted.size === 0) return;

    const { written } = assignmentTargets(ctx);

    ctx.tokens.forEach((t, i) => {
      if (t.t !== "id" || t.q || written.has(i) || punct(ctx.tokens[i - 1], ".")) return;
      const origin = tainted.get(ctx.dialect.foldIdentifier(t.v, false));
      if (!origin) return;

      const before = ctx.tokens[i - 1];
      const after = ctx.tokens[i + 1];
      const inArithmetic =
        (before?.t === "punct" && ARITHMETIC.has(before.v)) ||
        (after?.t === "punct" && ARITHMETIC.has(after.v));
      if (!inArithmetic || insideNullSafe(ctx.tokens, i)) return;

      ctx.report(
        t,
        `${t.v} comes from ${origin}, which is nullable; without COALESCE the whole expression is NULL`,
      );
    });
  },
};
