import type { Table } from "../../model/table.ts";
import { relations } from "../../syntax/fast/stmt.ts";
import { columnList, kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** Clauses that end a `JOIN`'s condition slot. The same bound `join-without-condition` walks to. */
const WHERE_BOUNDARY: ReadonlySet<string> = new Set(["GROUP", "ORDER", "HAVING", "LIMIT", "UNION", "INTO"]);

const JOIN_BOUNDARY: ReadonlySet<string> = new Set([
  "JOIN",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "SET",
  "UNION",
]);

/**
 * Aggregates a repeated row changes the answer of.
 *
 * `MIN` and `MAX` are not here and it is not an oversight: repeating a row cannot change the
 * smallest or the largest value, so a fan-out is invisible to them and reporting one would be
 * reporting a difference that does not exist.
 */
const COUNTS_EVERY_ROW: ReadonlySet<string> = new Set(["SUM", "AVG", "COUNT", "GROUP_CONCAT", "STD", "STDDEV", "VARIANCE"]);

/**
 * Operators that make their operands a **test** rather than a value.
 *
 * `SUM(IF(ca.kind = 'T', line.amount, 0))` mentions two relations and sums one of them: `ca.kind`
 * only decides which bucket the row lands in, and repeating the row does not change that decision.
 * Only what is being added up can be added up twice.
 */
const COMPARISONS: ReadonlySet<string> = new Set(["=", "<", ">", "<=", ">=", "<>", "!=", "<=>"]);

/** The same, written as words. `NOT` is not here: it negates a test, it does not make one. */
const COMPARISON_WORDS: ReadonlySet<string> = new Set(["IS", "IN", "LIKE", "BETWEEN", "REGEXP", "RLIKE", "SOUNDS"]);

/** Is this reference an operand of a comparison, rather than part of the value? */
function isTested(tokens: readonly { t: string; v: string; q?: boolean }[], before: number, after: number): boolean {
  for (const at of [before, after]) {
    const t = tokens[at];
    if (!t) continue;
    if (t.t === "punct" && COMPARISONS.has(t.v)) return true;
    if (t.t === "id" && !t.q && COMPARISON_WORDS.has(t.v.toUpperCase())) return true;
  }
  return false;
}

/** A join that can bring back more than one row per row of what it is joined to. */
interface Fan {
  /** The joined table, which is the many side. */
  table: Table;
  /** Folded alias or name, so a reference to it can be told apart from a reference to anything else. */
  label: string;
  /** The columns the condition pins down, as written. */
  on: string[];
  /** Token index of the `JOIN`. */
  at: number;
}

/**
 * The columns of the joined relation that the join condition fixes.
 *
 * `USING (a, b)` names them directly. An `ON` is read as a conjunction of equalities and nothing
 * else: the moment an `OR` shows up at the condition's own depth the shape is no longer "one row
 * matches one row" in any way this can reason about, and the join is left alone rather than guessed
 * at.
 *
 * @returns the columns, or `undefined` when the condition could not be read.
 */
function joinedColumns(ctx: StatementContext, joinIdx: number, label: string): string[] | undefined {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const columns: string[] = [];

  let i = joinIdx + 1;
  while (i <= ctx.statement.to) {
    const t = tokens[i]!;

    if (kw(t, "USING")) {
      if (!punct(tokens[i + 1], "(")) return undefined;
      return columnList(tokens, i + 1).names;
    }

    if (kw(t, "ON")) {
      let depth = 0;
      for (let j = i + 1; j <= ctx.statement.to; j++) {
        const u = tokens[j]!;
        if (punct(u, "(")) depth++;
        else if (punct(u, ")")) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && kw(u, "OR")) {
          return undefined;
        } else if (depth === 0 && (kwAny(u, JOIN_BOUNDARY) !== undefined || punct(u, ";"))) {
          break;
        } else if (punct(u, "=")) {
          // Either side may be the joined relation's: `ON a.id = b.id` and `ON b.id = a.id` are the
          // same join, and which one somebody wrote is not a fact about the data.
          for (const side of [j - 3, j + 1] as const) {
            if (tokens[side]?.t !== "id" || !punct(tokens[side + 1], ".") || tokens[side + 2]?.t !== "id") continue;
            if (fold(tokens[side]!.v) === label) columns.push(tokens[side + 2]!.v);
          }
        }
      }
      return columns;
    }

    if (punct(t, "(")) {
      const close = matchingParen(tokens, i);
      i = (close === -1 ? ctx.statement.to : close) + 1;
    } else if (kwAny(t, JOIN_BOUNDARY) !== undefined || punct(t, ";")) {
      return undefined;
    } else {
      i++;
    }
  }
  return undefined;
}

/**
 * Columns of the joined relation that the `WHERE` pins to a single value.
 *
 * A join condition is not the only thing that can make a match unique. `JOIN cor USING(a, b) WHERE
 * cor.c = pSomething` fixes all three columns of a three-column key, and the join brings back one
 * row — reporting it would be reporting the most ordinary shape there is.
 *
 * Only equalities at the clause's own depth, and only when no `OR` shares that depth: `a = 1 AND b =
 * 2 OR c` does not fix anything, and telling the difference for real is a parse this backend does
 * not do. What is on the other side of the `=` is not examined, because it does not matter — a
 * parameter, a literal or another relation's column all hold still while the joined table is scanned.
 */
function pinnedByWhere(ctx: StatementContext, scope: { from: number; to: number }, label: string): string[] {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  let where = -1;
  let depth = 0;
  for (let i = scope.from; i <= scope.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], "WHERE")) {
      where = i;
      break;
    }
  }
  if (where === -1) return [];

  const columns: string[] = [];
  depth = 0;
  for (let i = where + 1; i <= scope.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && kw(t, "OR")) {
      return [];
    } else if (depth === 0 && (kwAny(t, WHERE_BOUNDARY) !== undefined || punct(t, ";"))) {
      break;
    } else if (depth === 0 && punct(t, "=")) {
      for (const side of [i - 3, i + 1] as const) {
        if (tokens[side]?.t !== "id" || !punct(tokens[side + 1], ".") || tokens[side + 2]?.t !== "id") continue;
        if (fold(tokens[side]!.v) === label) columns.push(tokens[side + 2]!.v);
      }
    }
  }
  return columns;
}

/**
 * Is this join an **anti-join** — kept only for the rows where it found nothing?
 *
 * `LEFT JOIN t ON … WHERE t.id IS NULL` is how everybody writes "the rows without a match", and by
 * construction those rows matched nothing at all: there is no fan-out, ever. Without this the rule
 * reports the standard idiom, which is the fastest way to make people turn a rule off.
 *
 * The column tested has to be one a match could not have left NULL — a join key, or a column the
 * table declares `NOT NULL`. `WHERE t.optional_note IS NULL` over an inner join is an ordinary
 * filter and says nothing about how many rows came back.
 */
function isAntiJoin(ctx: StatementContext, scope: { from: number; to: number }, fan: Fan): boolean {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const keys = new Set(fan.on.map(fold));

  for (let i = scope.from; i <= scope.to; i++) {
    if (!punct(tokens[i], ".") || tokens[i - 1]?.t !== "id" || tokens[i + 1]?.t !== "id") continue;
    if (fold(tokens[i - 1]!.v) !== fan.label) continue;
    if (!kw(tokens[i + 2], "IS") || !kw(tokens[i + 3], "NULL")) continue;

    const name = fold(tokens[i + 1]!.v);
    if (keys.has(name) || fan.table.byName.get(name)?.nullable === false) return true;
  }
  return false;
}

/**
 * Do these columns pin the table to at most one row?
 *
 * The primary key or any unique index, wholly covered. Partly covered is not covered: half of a
 * two-column key identifies a group of rows, which is exactly the case this rule is about.
 */
function coversUniqueKey(dialect: StatementContext["dialect"], table: Table, columns: readonly string[]): boolean {
  const fixed = new Set(columns.map((name) => dialect.foldIdentifier(name, false)));
  const covered = (key: readonly string[]): boolean =>
    key.length > 0 && key.every((name) => fixed.has(dialect.foldIdentifier(name, false)));

  if (covered(table.primaryKey)) return true;
  return table.indexes.some((index) => index.unique && covered(index.columns));
}

export const joinMultipliesAggregate: Rule = {
  id: "query/join-multiplies-aggregate",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A \`SUM\` over one table's column, in a query joined to another table that can match more than
once.

A join to a table where the join key is not unique brings back one row per match, and every column of
the other side is repeated along with them. An aggregate over one of those columns then counts it once
per match: \`SUM(o.total)\` across a join to a table with three rows per order returns three times the
money.

**It is the catalog that makes this checkable**, and nothing else can. Reading the query tells you
there is a join; only the schema tells you whether the joined key is unique, and that is the entire
difference between a correct query and one that has been quietly returning the wrong number for years.
The test is the joined table's primary key or one of its unique indexes, **wholly** covered by the
condition — half of a two-column key identifies a group of rows, which is the case this is about.

What it deliberately leaves alone:

  - **\`MIN\` and \`MAX\`.** Repeating a row cannot change the smallest or the largest value.
  - **\`COUNT(DISTINCT …)\`**, which is the usual way somebody who knew about the fan-out wrote around it.
  - **An aggregate over the joined table's own columns.** Those rows are not repeated — they are what
    the join returned, and summing them is normally the point.
  - **A reference that is only a test.** In \`SUM(IF(a.kind = 'T', b.amount, 0))\` the \`a.kind\` decides
    which bucket the row falls in; what is added up is \`b.amount\`, and only what is added up can be
    added up twice.
  - **A key the \`WHERE\` finishes.** \`JOIN cor USING(a, b) WHERE cor.c = pSomething\` fixes all three
    columns of a three-column key, and one row comes back.
  - **An anti-join.** \`LEFT JOIN t ON … WHERE t.id IS NULL\` keeps exactly the rows that matched
    nothing, so nothing is repeated. It is also the standard way to write that, and reporting it
    would be the fastest way to get the rule turned off.
  - **A condition it cannot read as a conjunction of equalities.** An \`OR\` in an \`ON\` is not a shape
    this can reason about, and guessing there would report joins that are fine.`,

  check(ctx) {
    const { tokens, dialect } = ctx;
    const fold = (name: string): string => dialect.foldIdentifier(name, false);

    // The joins that can multiply, with the scope each one belongs to.
    const fans = new Map<unknown, Fan[]>();
    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!kw(tokens[i], "JOIN")) continue;
      const before = tokens[i - 1];
      const kind = before?.t === "id" && !before.q ? before.v.toUpperCase() : "";
      if (kind === "CROSS" || kind === "NATURAL") continue;

      const joined = relations(dialect, tokens, i, Math.min(i + 16, ctx.statement.to))[0];
      if (!joined?.name || joined.cte || joined.derived) continue;
      const key = fold(joined.name);
      if (ctx.catalog.tempTable(joined.name) || ctx.locals.byName.has(key)) continue;
      const table = ctx.catalog.table(joined.name);
      if (!table) continue;

      const label = fold(joined.alias ?? joined.name);
      const on = joinedColumns(ctx, i, label);
      // No condition at all is `query/join-without-condition`'s finding, not this one.
      if (!on || on.length === 0) continue;

      const scope = ctx.scopeAt(i);
      const pinned = scope ? [...on, ...pinnedByWhere(ctx, scope, label)] : on;
      if (coversUniqueKey(dialect, table, pinned)) continue;

      const fan: Fan = { table, label, on, at: i };
      if (scope && isAntiJoin(ctx, scope, fan)) continue;

      const list = fans.get(scope);
      if (list) list.push(fan);
      else fans.set(scope, [fan]);
    }
    if (fans.size === 0) return;

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const t = tokens[i]!;
      if (t.t !== "id" || t.q || !punct(tokens[i + 1], "(")) continue;
      if (!COUNTS_EVERY_ROW.has(t.v.toUpperCase())) continue;

      const close = matchingParen(tokens, i + 1);
      if (close === -1) continue;
      // Whoever wrote `DISTINCT` knew, and this is what they knew about.
      if (kw(tokens[i + 2], "DISTINCT")) continue;

      const scope = ctx.scopeAt(i);
      const here = fans.get(scope);
      if (!here) continue;

      for (let j = i + 2; j < close; j++) {
        if (!punct(tokens[j], ".") || tokens[j - 1]?.t !== "id" || tokens[j + 1]?.t !== "id") continue;
        // An aggregate's parentheses can hold a whole subquery — `SUM(a.x - (SELECT … WHERE b.y …))`
        // — and a name in there belongs to that query, not to this one. Without this the rule blames
        // the outer join for a reference it never touches.
        if (ctx.scopeAt(j) !== scope) continue;

        // `SUM(IF(other.kind = 'T', fanned.amount, 0))` is not multiplied: the reference to the other
        // relation is a test, and a test does not get added up.
        if (isTested(tokens, j - 2, j + 2)) continue;

        const alias = fold(tokens[j - 1]!.v);
        const relation = ctx.aliasesFor(j - 1, alias).get(alias);
        if (!relation?.name || relation.cte) continue;
        // A column of the many side is not repeated: it is what the join returned.
        if (here.some((fan) => fan.label === alias)) continue;
        if (!ctx.catalog.table(relation.name)) continue;

        const fan = here[0]!;
        ctx.report(
          t,
          `${t.v.toUpperCase()} over ${tokens[j - 1]!.v}.${tokens[j + 1]!.v} is multiplied by the join to ` +
            `${fan.table.name}: ${fan.on.join(", ")} is not unique there`,
        );
        break;
      }
    }
  },
};
