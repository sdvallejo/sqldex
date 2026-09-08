import { bareColumnCandidate } from "../shared/names.ts";
import { clauseAt, SELECT_MODIFIERS } from "../shared/selects.ts";
import { kw, kwAny, matchingParen, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/** Words that end the `ORDER BY` list at its own depth. */
const AFTER_ORDER: ReadonlySet<string> = new Set(["LIMIT", "INTO", "PROCEDURE", "FOR", "LOCK", "UNION"]);

/**
 * The column names a range refers to, with the tokens they were written as.
 *
 * A subquery is stepped over whole — its names are its own — and a function's name is not a column
 * however much it looks like one, while its arguments still are: `ORDER BY LENGTH(label)` orders by
 * `label`, and that is exactly the reference this rule has to see.
 */
function columnRefs(ctx: StatementContext, from: number, to: number): Token[] {
  const { tokens, dialect } = ctx;
  const found: Token[] = [];

  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(") && kw(tokens[i + 1], "SELECT")) {
      const close = matchingParen(tokens, i);
      i = close === -1 ? to : close;
      continue;
    }
    if (t.t !== "id") continue;
    // A call's name, not a column. The walk continues into its arguments.
    if (punct(tokens[i + 1], "(")) continue;
    if (ctx.locals.byName.has(dialect.foldIdentifier(t.v, false)) && !punct(tokens[i + 1], ".")) continue;

    if (punct(tokens[i + 1], ".") && tokens[i + 2]?.t === "id") {
      found.push(tokens[i + 2]!);
      i += 2;
    } else if (bareColumnCandidate(tokens, i)) {
      found.push(t);
    }
  }
  return found;
}

export const distinctOrderByHiddenColumn: Rule = {
  id: "query/distinct-order-by-hidden-column",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A \`SELECT DISTINCT\` ordered by a column it does not return.

\`DISTINCT\` collapses rows, and the collapsing happens before the ordering: once two rows have become
one, a column that was not selected has two values and no way to choose between them. MySQL says so —
error 3065, *expression #1 of ORDER BY clause is not in SELECT list … this is incompatible with
DISTINCT* — under \`ONLY_FULL_GROUP_BY\`, which has been the default since 5.7.

Without that mode the server answers instead, and that is the case worth catching: the rows come back
ordered by *an* arbitrary value of the hidden column, so the query works, the report looks sorted, and
it stops working the day it runs on a server with the default settings. The same two-faced behaviour
as \`query/only-full-group-by\`, and it is reported at the same severity for the same reason.

**A column counts as returned only where the list names it as a column** — and that is the server's
own line, checked case by case rather than assumed. \`SELECT DISTINCT DATE(created) … ORDER BY
created\` is refused: the list holds an expression, not the column, and the ordering asks for
something the result does not carry. \`SELECT DISTINCT label … ORDER BY LENGTH(label)\` is accepted,
because the column *is* returned and the function only reshapes it.

Qualifiers are ignored on both sides: \`SELECT DISTINCT o.total … ORDER BY total\` is one column
written two ways, and reading them as two would report a query the server accepts.

What it leaves alone:

  - **An alias**: \`SELECT DISTINCT CONCAT(a, b) AS label … ORDER BY label\` orders by the result, which
    is returned.
  - **An expression the list repeats verbatim** — \`SELECT DISTINCT a + b … ORDER BY a + b\` is
    accepted by the server even though neither column is returned on its own, so the item is matched
    as written before its columns are looked at.
  - **An ordinal** — \`ORDER BY 1\` names a position in the list, and is always in it.
  - **A name that belongs to no relation of the query**, which is \`names/unknown-column\`'s finding:
    the ordering is broken there for a different reason, and this rule has nothing to add.
  - **\`SELECT DISTINCT *\`**, which returns everything, and a subquery in the \`ORDER BY\`, whose names
    are its own.`,

  check(ctx) {
    const { tokens, dialect } = ctx;
    if (!kw(tokens[ctx.statement.from], "SELECT")) return;

    let at = ctx.statement.from + 1;
    let distinct = false;
    while (kwAny(tokens[at], SELECT_MODIFIERS) !== undefined) {
      if (kw(tokens[at], "DISTINCT") || kw(tokens[at], "DISTINCTROW")) distinct = true;
      at++;
    }
    if (!distinct) return;

    const order = clauseAt(ctx, "ORDER", "BY");
    if (order === -1) return;
    const from = clauseAt(ctx, "FROM");
    const into = clauseAt(ctx, "INTO");
    const end = from === -1 ? into : into === -1 ? from : Math.min(from, into);
    if (end === -1 || end <= at) return;

    // A `*` of the list itself returns every column, so nothing can be hidden behind it. `COUNT(*)`
    // is not one of those stars.
    let depth = 0;
    for (let i = at; i < end; i++) {
      if (punct(tokens[i], "(")) depth++;
      else if (punct(tokens[i], ")")) depth--;
      else if (depth === 0 && punct(tokens[i], "*")) return;
    }

    const fold = (name: string): string => dialect.foldIdentifier(name, false);
    const text = (from: number, to: number): string =>
      tokens
        .slice(from, to + 1)
        .map((t) => t.v.toLowerCase())
        .join("");

    /** Names the result carries: a column the list names as a column, and the name an item is given. */
    const returned = new Set<string>();
    /** Each item as written, so an expression the ordering repeats verbatim is returned too. */
    const listed = new Set<string>();

    for (const item of splitCommas(tokens, at, end - 1)) {
      let last = item.to;
      const tail = tokens[last];
      // `expr AS label`, and the bare `expr label` — but not `t.col`, whose last token is the column.
      if (tail?.t === "id" && last > item.from && !punct(tokens[last - 1], ".")) {
        if (kw(tokens[last - 1], "AS") || !punct(tokens[last - 1], "(")) {
          returned.add(fold(tail.v));
          last = kw(tokens[last - 1], "AS") ? last - 2 : last - 1;
        }
      }
      listed.add(text(item.from, last));

      // Only an item that **is** a column returns that column. A column inside an expression is not
      // returned, and the server says so: `DATE(created)` in the list does not carry `created`.
      if (last === item.from && tokens[item.from]?.t === "id") returned.add(fold(tokens[item.from]!.v));
      else if (last === item.from + 2 && punct(tokens[item.from + 1], ".") && tokens[last]?.t === "id") {
        returned.add(fold(tokens[last]!.v));
      }
    }

    let stop = order + 2;
    depth = 0;
    while (stop <= ctx.statement.to) {
      const t = tokens[stop]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && (punct(t, ";") || kwAny(t, AFTER_ORDER) !== undefined)) break;
      stop++;
    }

    for (const item of splitCommas(tokens, order + 2, stop - 1)) {
      let last = item.to;
      if (kw(tokens[last], "ASC") || kw(tokens[last], "DESC")) last--;
      // The whole item as written: `ORDER BY a + b` beside `SELECT DISTINCT a + b`.
      if (listed.has(text(item.from, last))) continue;

      for (const reference of columnRefs(ctx, item.from, last)) {
        const name = fold(reference.v);
        if (returned.has(name)) continue;
        // A name no relation of this query has is `names/unknown-column`'s to report; without an
        // owner there is no column being ordered by, and nothing here to say about it.
        const owned = ctx.relations.some((relation) => {
          const table = relation.name ? ctx.catalog.table(relation.name) : undefined;
          return table?.byName.has(name) === true;
        });
        if (!owned) continue;

        ctx.report(
          reference,
          `${reference.v} orders a SELECT DISTINCT that does not return it: once the rows are ` +
            "collapsed this column has no single value, and a server with ONLY_FULL_GROUP_BY refuses the query",
        );
        return;
      }
    }
  },
};
