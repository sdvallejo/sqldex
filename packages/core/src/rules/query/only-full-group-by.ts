import { relations } from "../../syntax/fast/stmt.ts";
import { columnList, kw, kwAny, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import { AGGREGATES } from "../one-row.ts";
import type { Rule, StatementContext } from "../rule.ts";
import { bareColumnCandidate, coversUniqueKey } from "../support.ts";

/** Clauses that end the `GROUP BY` list. */
const AFTER_GROUP: ReadonlySet<string> = new Set(["HAVING", "ORDER", "LIMIT", "INTO", "UNION", "WITH", "PROCEDURE"]);

/** A column named in the select list, with what it was written as. */
interface Reference {
  token: Token;
  /** Token index of the name, which is how an alias map is asked what it stands for. */
  at: number;
  /** Folded qualifier, when it was written qualified. */
  alias?: string;
  /** `o.total` or `total`, folded — how a `GROUP BY` item is compared against it. */
  text: string;
}

/** The index of a keyword at the statement's own depth, or `-1`. */
function clauseAt(ctx: StatementContext, word: string, second?: string): number {
  const { tokens } = ctx;
  let depth = 0;
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (punct(tokens[i], "(")) depth++;
    else if (punct(tokens[i], ")")) depth--;
    else if (depth === 0 && kw(tokens[i], word) && (second === undefined || kw(tokens[i + 1], second))) return i;
  }
  return -1;
}

/**
 * Column references in a range, skipping what is not one of this query's ungrouped values.
 *
 * Three things are stepped over whole, and each for its own reason: an **aggregate's** arguments,
 * which is the point of aggregating; a **nested subquery**, whose names belong to it; and a
 * function's name, which is not a column however much it looks like one.
 */
function references(ctx: StatementContext, from: number, to: number): Reference[] {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);
  const found: Reference[] = [];

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (t.t === "id" && !t.q && punct(tokens[i + 1], "(")) {
      const close = matchingParen(tokens, i + 1);
      // An aggregate's arguments are grouped by construction; anything else's are not, so only the
      // call's own name is skipped and the walk continues inside it.
      if (AGGREGATES.has(t.v.toUpperCase())) i = close === -1 ? to : close;
      continue;
    }
    if (t.t !== "id") continue;
    // A parameter or a `DECLARE`d variable is a constant for the query, which is what
    // `ONLY_FULL_GROUP_BY` asks of anything ungrouped.
    if (ctx.locals.byName.has(fold(t.v)) && !punct(tokens[i + 1], ".")) continue;

    if (punct(tokens[i + 1], ".") && tokens[i + 2]?.t === "id") {
      const name = tokens[i + 2]!;
      found.push({ token: name, at: i + 2, alias: fold(t.v), text: `${fold(t.v)}.${fold(name.v)}` });
      i += 2;
    } else if (bareColumnCandidate(tokens, i)) {
      found.push({ token: t, at: i, text: fold(t.v) });
    }
  }
  return found;
}

/** One item of a select list: what it reads, and what the result is called. */
interface Item {
  refs: Reference[];
  /** The name the item is given, folded — `expr AS x` and `expr x` alike. */
  label?: string;
}

/**
 * The select list, cut into items with their result names taken off.
 *
 * **The name a select item is given is not a column of anything**, and reading it as one reports
 * every report in the repository: `CONCAT(a, b) AS label` mentions `label` nowhere in the schema.
 * Both spellings have to be recognised, because these files use both — the `AS` is optional in
 * MySQL and half the queries leave it out.
 *
 * Taking it off is also what makes `GROUP BY label` work, which is the other half of the same fact:
 * the clause may name the item rather than the expression, and then the item is grouped.
 */
function items(ctx: StatementContext, from: number, to: number): Item[] {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  return splitCommas(tokens, from, to).map((span) => {
    let end = span.to;
    let label: string | undefined;
    const last = tokens[end];
    // `expr AS x`, and the bare `expr x` — but not `a.b`, whose last token is the column, and not a
    // lone `col`, which is the reference itself.
    if (last?.t === "id" && end > span.from && !punct(tokens[end - 1], ".")) {
      const isAlias = kw(tokens[end - 1], "AS") || !punct(tokens[end - 1], "(");
      if (isAlias) {
        label = fold(last.v);
        end = kw(tokens[end - 1], "AS") ? end - 2 : end - 1;
      }
    }
    return { refs: references(ctx, span.from, end), label };
  });
}

/**
 * Which relations the grouping pins to one row each, including the ones it reaches through a join.
 *
 * This is the half of `ONLY_FULL_GROUP_BY` that MySQL itself implements and a naive reading of the
 * clause does not. Grouping by a table's whole primary key gives one row of that table per group, so
 * every column of it is determined. And a table joined to a determined one **by its own whole unique
 * key** is determined in turn: `GROUP BY c.id` with `JOIN groups g ON g.id = c.group_id` means one
 * `g` per group as surely as if `g.id` had been written in the clause.
 *
 * Without this the rule reports every report-style query in the repository — queries the server
 * accepts — which is the definition of arguing with correct SQL.
 *
 * The closure is repeated until nothing new is determined, because the reach can be a chain: one
 * join off the grouped table, then another off that one.
 */
function determinedRelations(ctx: StatementContext, groupedByAlias: ReadonlyMap<string, string[]>): Set<string> {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  const tableFor = (alias: string): { table: ReturnType<typeof ctx.catalog.table> } => {
    const relation = ctx.byAlias.get(alias);
    return { table: relation?.name ? ctx.catalog.table(relation.name) : undefined };
  };

  const pinned = new Map<string, Set<string>>();
  for (const [alias, columns] of groupedByAlias) pinned.set(alias, new Set(columns.map(fold)));

  const determined = new Set<string>();
  const settle = (): boolean => {
    let grew = false;
    for (const [alias, columns] of pinned) {
      if (determined.has(alias)) continue;
      const { table } = tableFor(alias);
      if (table && coversUniqueKey(fold, table, [...columns])) {
        determined.add(alias);
        grew = true;
      }
    }
    return grew;
  };
  settle();

  // `JOIN t USING (k)` is an equality with neither side written, and these schemas write joins that
  // way more often than not. It is fed to the same closure as an `ON`, because that is what it is:
  // the two relations share that column, so determining one end determines the other. Pinning it
  // outright would be wrong — `USING` equates, it does not fix a value.
  const equalities: { left: [string, string]; right: [string, string] }[] = [];
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (!kw(tokens[i], "USING") || !punct(tokens[i + 1], "(")) continue;
    const joined = relations(dialect, tokens, Math.max(i - 8, ctx.statement.from), i).slice(-1)[0];
    if (!joined?.name) continue;
    const label = fold(joined.alias ?? joined.name);

    for (const name of columnList(tokens, i + 1).names) {
      const column = fold(name);
      for (const other of ctx.relations) {
        if (!other.name) continue;
        const otherLabel = fold(other.alias ?? other.name);
        if (otherLabel === label) continue;
        if (ctx.catalog.table(other.name)?.byName.has(column) !== true) continue;
        equalities.push({ left: [label, column], right: [otherLabel, column] });
      }
    }
  }

  // Every `a.x = b.y` in the statement, whichever clause it sits in: an `ON` and a `WHERE` pin a row
  // down equally well, and which one the author used is not a fact about the data.
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    if (!punct(tokens[i], "=")) continue;
    const left = i - 3;
    const right = i + 1;
    if (tokens[left]?.t !== "id" || !punct(tokens[left + 1], ".") || tokens[left + 2]?.t !== "id") continue;
    if (tokens[right]?.t !== "id" || !punct(tokens[right + 1], ".") || tokens[right + 2]?.t !== "id") continue;
    equalities.push({
      left: [fold(tokens[left]!.v), fold(tokens[left + 2]!.v)],
      right: [fold(tokens[right]!.v), fold(tokens[right + 2]!.v)],
    });
  }

  for (let pass = 0; pass < equalities.length + 1; pass++) {
    let grew = false;
    for (const { left, right } of equalities) {
      for (const [from, to] of [
        [left, right],
        [right, left],
      ] as const) {
        if (!determined.has(from[0]) || determined.has(to[0])) continue;
        const columns = pinned.get(to[0]) ?? new Set<string>();
        if (!columns.has(to[1])) {
          columns.add(to[1]);
          pinned.set(to[0], columns);
          grew = true;
        }
      }
    }
    if (settle()) grew = true;
    if (!grew) break;
  }
  return determined;
}

export const onlyFullGroupBy: Rule = {
  id: "query/only-full-group-by",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A column in the select list that is neither grouped nor aggregated.

Two different things happen to it, and the quiet one is worse. A server with \`ONLY_FULL_GROUP_BY\`
— the default since 5.7 — refuses the statement outright, error 1055. A server without it runs the
query and returns **an arbitrary row's** value for that column: not the first, not the largest, no
promise at all, and the number looks exactly like a number. A query written on the second kind of
server stops working the day it is run on the first.

**The catalog is what makes this usable rather than pedantic.** MySQL accepts an ungrouped column
when the grouping *determines* it — group by a table's primary key and every other column of that
table has one value per group, which is a fact about the schema and not about the query. Reading
that dependence out of the DDL is what lets the rule stay quiet on the ordinary shape,
\`GROUP BY o.order_id\` with half the order in the select list, and still report the one that is not.

What it deliberately leaves alone:

  - **A column the grouping determines**, as above: a whole primary key or unique index of its own
    relation, in the \`GROUP BY\`.
  - **An expression that appears in the \`GROUP BY\` as written.** \`GROUP BY DATE(t.created)\` with
    \`DATE(t.created)\` in the list is grouped, and matching it by text is what avoids arguing with
    the author about their own expression.
  - **\`SELECT *\`**, where there is nothing to name and the answer would be a guess.
  - **A query with no aggregate and no \`GROUP BY\`**, which is every ordinary select.`,

  check(ctx) {
    const { tokens, dialect } = ctx;
    if (!kw(tokens[ctx.statement.from], "SELECT")) return;

    // Whichever comes first, and the order matters: `SELECT COUNT(*) INTO v FROM t` puts the
    // variables *before* the `FROM`, and reading them as columns of the query reports every
    // procedure that counts something into a variable.
    const from = clauseAt(ctx, "FROM");
    const into = clauseAt(ctx, "INTO");
    const end = from === -1 ? into : into === -1 ? from : Math.min(from, into);
    if (end === -1) return;

    const group = clauseAt(ctx, "GROUP", "BY");
    const list = items(ctx, ctx.statement.from + 1, end - 1);
    // With no `GROUP BY`, an aggregate anywhere in the list is what makes the rest of it a defect:
    // `SELECT a, SUM(b) FROM t` is one row, and `a` comes from whichever of them the server liked.
    if (group === -1 && !hasAggregate(ctx, ctx.statement.from + 1, end - 1)) return;
    // A `*` says nothing about which columns those are, so there is nothing to check — but only a
    // `*` of the list itself. `COUNT(*)` is a star inside a call, and it is in nearly every grouped
    // query there is: reading it as a wildcard silences the rule almost everywhere.
    let depth = 0;
    for (let i = ctx.statement.from + 1; i < end; i++) {
      if (punct(tokens[i], "(")) depth++;
      else if (punct(tokens[i], ")")) depth--;
      else if (depth === 0 && punct(tokens[i], "*")) return;
    }
    if (list.every((item) => item.refs.length === 0)) return;

    // What the `GROUP BY` holds: each item as written, folded, plus its columns per relation.
    const grouped = new Set<string>();
    const columnsByAlias = new Map<string, string[]>();
    if (group !== -1) {
      let stop = group + 2;
      let depth = 0;
      while (stop <= ctx.statement.to) {
        const t = tokens[stop]!;
        if (punct(t, "(")) depth++;
        else if (punct(t, ")")) depth--;
        else if (depth === 0 && (kwAny(t, AFTER_GROUP) !== undefined || punct(t, ";"))) break;
        stop++;
      }
      for (const item of references(ctx, group + 2, stop - 1)) {
        grouped.add(item.text);
        const key = item.alias ?? "";
        const columns = columnsByAlias.get(key);
        if (columns) columns.push(item.token.v);
        else columnsByAlias.set(key, [item.token.v]);
      }
      // Each item as written, so an expression grouped by verbatim matches the same expression in
      // the list. Per item and not per clause: a `GROUP BY` of three things is not one long name.
      for (const item of splitCommas(tokens, group + 2, stop - 1)) {
        grouped.add(
          tokens
            .slice(item.from, item.to + 1)
            .map((t) => t.v.toLowerCase())
            .join(""),
        );
      }
    }

    const fold = (name: string): string => dialect.foldIdentifier(name, false);

    // A `GROUP BY` written without qualifiers — which is how most of them are written — is filed
    // under **every** relation that has such a column, not under the one that does.
    // `JOIN t USING (k)` merges the two `k` into one column, so a join key belongs to both ends at
    // once, and demanding a single owner would leave every join key attributed to nobody. Naming a
    // column that is not a key of a relation costs nothing: pinning only matters where it covers
    // one.
    for (const name of columnsByAlias.get("") ?? []) {
      for (const relation of ctx.relations) {
        const table = relation.name ? ctx.catalog.table(relation.name) : undefined;
        if (!table?.byName.has(fold(name)) || !relation.name) continue;
        const label = fold(relation.alias ?? relation.name);
        const columns = columnsByAlias.get(label);
        if (columns) columns.push(name);
        else columnsByAlias.set(label, [name]);
      }
    }

    const determined = determinedRelations(ctx, columnsByAlias);
    // A query over one relation writes its columns unqualified, so the grouping that determines
    // them is filed under no alias at all.
    const only = ctx.relations.length === 1 ? ctx.relations[0] : undefined;
    if (only?.name && determined.has(fold(only.alias ?? only.name))) determined.add("");
    if (columnsByAlias.has("") && only?.name) {
      const table = ctx.catalog.table(only.name);
      if (table && coversUniqueKey(fold, table, columnsByAlias.get("") ?? [])) determined.add("");
    }

    for (const item of list) {
      // The clause may name the item rather than repeat its expression.
      if (item.label !== undefined && grouped.has(item.label)) continue;
      for (const reference of item.refs) {
        if (grouped.has(reference.text)) continue;

        // A bare name is attributed to the one relation of this query that has such a column. Where
        // several do, or none does, there is nothing to attribute it to — and a rule that cannot say
        // whose column it is cannot say whether the grouping determines it.
        if (reference.alias !== undefined) {
          if (determined.has(reference.alias)) continue;
        } else {
          // The same merged-column reading: a bare name is this query's column wherever it lives,
          // so one determined owner is enough. Where no relation has it, there is nothing to judge.
          const owners = ctx.relations.filter((relation) => {
            const table = relation.name ? ctx.catalog.table(relation.name) : undefined;
            return table?.byName.has(reference.text) === true;
          });
          if (owners.length === 0) continue;
          if (owners.some((relation) => determined.has(fold(relation.alias ?? relation.name!)))) continue;
        }

        // One per statement, on the first that is not grouped. The server stops at the first too,
        // and a report with a dozen ungrouped columns is one query to fix, not a dozen findings to
        // read.
        ctx.report(
          reference.token,
          `${reference.text} is neither grouped nor aggregated: a server with ONLY_FULL_GROUP_BY ` +
            "refuses this, and one without it returns an arbitrary row's value",
        );
        return;
      }
    }
  },
};

/** Does the range hold an aggregate call of its own? */
function hasAggregate(ctx: StatementContext, from: number, to: number): boolean {
  const { tokens } = ctx;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (t.t === "id" && !t.q && punct(tokens[i + 1], "(") && AGGREGATES.has(t.v.toUpperCase())) return true;
  }
  return false;
}
