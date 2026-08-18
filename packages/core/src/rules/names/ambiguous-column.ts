import { bareColumnCandidate, joinNames } from "../shared/names.ts";
import { columnNames, relation as resolveRelation } from "../../analysis/resolve.ts";
import { selectListColumns } from "../../analysis/locals.ts";
import { kw, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { DocumentContext, Rule, ScopeInfo } from "../rule.ts";

/** What a scope resolves a bare name against, worked out once per scope. */
interface Described {
  /** Which relations hold each name — the names, not a count. */
  holders: Map<string, string[]>;
  /** Names a `USING (...)` merged into one column, so they are no longer ambiguous. */
  merged: Set<string>;
  /** A `NATURAL JOIN` merges every shared name, without saying which. */
  natural: boolean;
  /** Names the `SELECT` list produces. */
  output: Set<string>;
  /** Token indexes where the list *defines* a name rather than reading a column. */
  defines: Set<number>;
  /** Where `GROUP BY` / `ORDER BY` / `HAVING` begins, past which the output names are visible. */
  tail: number;
}

function describe(ctx: DocumentContext, scope: ScopeInfo): Described {
  const { tokens, dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  const holders = new Map<string, string[]>();
  for (const relation of scope.relations) {
    const label = relation.alias ?? relation.name;
    if (!label) continue;
    const resolved = resolveRelation({ dialect, catalog: ctx.catalog, schemas: ctx.schemas }, ctx.locals, relation);
    for (const name of columnNames(resolved)) {
      const key = fold(name);
      const list = holders.get(key);
      if (list) list.push(label);
      else holders.set(key, [label]);
    }
  }

  const merged = new Set<string>();
  let natural = false;
  let depth = 0;
  for (let i = scope.from; i <= scope.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "NATURAL")) natural = true;
    else if (depth === 0 && kw(t, "USING") && punct(tokens[i + 1], "(")) {
      const close = matchingParen(tokens, i + 1);
      for (let j = i + 2; j <= (close === -1 ? i + 1 : close) - 1; j++) {
        if (tokens[j]!.t === "id") merged.add(fold(tokens[j]!.v));
      }
    }
  }

  const output = new Set<string>();
  let defines = new Set<number>();
  let tail = Number.POSITIVE_INFINITY;
  if (kw(tokens[scope.from], "SELECT")) {
    const list = selectListColumns(tokens, scope.from, scope.to);
    for (const name of list.names) output.add(fold(name));
    defines = list.definedAt;

    depth = 0;
    for (let i = scope.from; i <= scope.to; i++) {
      const t = tokens[i]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && (kw(t, "GROUP") || kw(t, "ORDER") || kw(t, "HAVING"))) {
        tail = i;
        break;
      }
    }
  }

  return { holders, merged, natural, output, defines, tail };
}

export const ambiguousColumn: Rule = {
  id: "names/ambiguous-column",
  group: "names",
  severity: "error",
  scope: "document",
  docs: `An unqualified column that more than one of the query's relations has.

MySQL rejects it outright — *Column 'x' in where clause is ambiguous*, error 1052 — so this is an
error and not a matter of taste. It is also the rule whose value is most clearly **prospective**: a
fatal error gets fixed the first time it is hit, so a schema that has been in production for years
is a survivor sample, and finding few says where the damage was tolerable rather than where it
matters. What it is for is catching one as you type, instead of when that branch finally runs.

**The scope model is the rule.** Ambiguity is a question about a *query*, and the \`;\` bound the other
rules share is not one: it merges \`IF EXISTS(SELECT … FROM a) THEN UPDATE b\` into a single set of
relations and then manufactures findings by the thousand out of names that were never in the same
query. Query scopes cut per query instead, and a name resolves in the **innermost** scope that has it
— which is what MySQL does, and what makes a correlated subquery reading an outer column work.

Four things are not ambiguity, and each removes a class of false positive:

  - **A local, a table or a routine of that name.** Then it is not a column reference at all.
  - **A name the \`SELECT\` list defines.** \`DATE_FORMAT(t.started_at, '%d/%m/%Y') started_at\` writes
    the same word twice, and the first one **is** a column, so the two are only distinguishable by
    position — never by name.
  - **\`USING (col)\`, and \`NATURAL JOIN\`.** Those merge the column into one, which is precisely the
    thing that stops it being ambiguous.
  - **\`GROUP BY\` / \`ORDER BY\` / \`HAVING\`.** Those three clauses see the query's **output** names, and
    nothing else does: \`SELECT a.f … ORDER BY f\` is accepted where \`WHERE f\` is not.

Once a scope has the name, the answer is that scope's, ambiguous or not: MySQL stops at the innermost
one and never looks further out.`,

  check(ctx) {
    const scopes = ctx.scopes();
    if (scopes.length === 0) return;

    const described = new Map<ScopeInfo, Described>();
    const of = (scope: ScopeInfo): Described => {
      let hit = described.get(scope);
      if (!hit) described.set(scope, (hit = describe(ctx, scope)));
      return hit;
    };

    ctx.tokens.forEach((token, i) => {
      if (!bareColumnCandidate(ctx.tokens, i)) return;
      const key = ctx.dialect.foldIdentifier(token.v, false);

      let scope = ctx.scopeAt(i);
      // A name that means something else here is not a column reference. The select-list case needs
      // the scope, so it is asked about before the walk outwards begins.
      if (
        ctx.locals.byName.has(key) ||
        ctx.catalog.table(token.v) ||
        ctx.catalog.routine(token.v) ||
        ctx.catalog.tempTable(token.v) ||
        (scope && of(scope).defines.has(i))
      ) {
        return;
      }

      while (scope) {
        const info = of(scope);
        const holders = info.holders.get(key);
        if (holders) {
          const mergedAway =
            info.merged.has(key) || info.natural || (i >= info.tail && info.output.has(key));
          if (holders.length > 1 && !mergedAway) {
            ctx.report(
              token,
              `${token.v} is ambiguous: ${joinNames(holders)} ${holders.length === 2 ? "both" : "all"} have it`,
            );
          }
          return;
        }
        scope = scope.parent;
      }
    });
  },
};
