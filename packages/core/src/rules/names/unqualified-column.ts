import { bareColumnCandidate, knownBareName, selectOutputAliases } from "../shared/names.ts";
import { cteNames } from "../../syntax/fast/stmt.ts";
import { statementSetTargets } from "../shared/writes.ts";
import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Token } from "../../syntax/types.ts";
import { relation as resolveRelation } from "../../analysis/resolve.ts";
import type { Table } from "../../model/table.ts";
import type { Rule, ScopeInfo } from "../rule.ts";

export const unqualifiedColumn: Rule = {
  id: "names/unqualified-column",
  group: "names",
  severity: "warn",
  scope: "statement",
  docs: `A bare column name — \`status\` rather than \`o.status\` — that none of the statement's tables has.

**This is the rule that needs the most guards, and unguarded it is worse than nothing.** Every
reserved word, every alias, every block label and every output name in the file reads as a column that
no table has, and the result is thousands of warnings on a schema of any size. What makes it accurate
is the exclusions, and each removes a class rather than a case:

  - **Every relation the name could belong to must have resolved** — those of the query it sits in,
    and of every query enclosing it. This is the important one. With a temporary or derived table in
    the mix, the set of valid columns is *unknown*, and claiming a name is not among them would be
    guessing — so the rule stands down on that query rather than half-checking it. The bound is the
    query, not the \`;\`: the condition of an \`IF EXISTS (SELECT …) THEN\` runs to the end of the first
    statement of its \`THEN\`, and a table that one does not know says nothing about the subquery's.
  - **An alias or table name from the statement itself.** Without this the \`o\` of \`FROM orders o\` gets
    flagged, which is almost all of the remaining noise.
  - **An output name the \`SELECT\` defines**, which can also be used later in an \`ORDER BY\`.
  - **A \`WITH\` name**, which the statement defines exactly like an output alias.
  - **A local, a routine, or a temporary table** from anywhere in the project.

What survives all of that is a name that genuinely is not a column of any table in the query, in a
query where every table is known — and those, checked by hand, turn out to be real.

**Inside a routine or a trigger the name may be a variable that was never declared**, and the message
says so — \`unknown column or variable\` — because a misspelled local in a \`WHERE\` reads exactly like
a misspelled column and the rule cannot tell which was meant. Outside one there is no \`DECLARE\` section
to have missed the name from, and the message says \`unknown column\`.

**The target of a statement-level \`SET\` is never reported here**, even when the statement has a table
in it through a subquery: that position is never a column, and \`routine/undeclared-variable\` is the
rule that says what it is instead.`,

  check(ctx) {
    // With anything unresolved the valid set is unknown, and guessing is what this rule must not do.
    // The statement-wide answer is only the fallback, for a name that sits in no query at all.
    const statementResolved = ctx.resolved.length > 0 && ctx.resolved.length === ctx.relations.length;
    // The tables a bare name in this query can be a column of: its own and those of every query
    // enclosing it, which is where MySQL looks for it. `undefined` when any of them is unknown.
    const chains = new Map<ScopeInfo, readonly Table[] | undefined>();
    const ownTables = new Map<ScopeInfo, Table[] | undefined>();
    const resolveContext = { dialect: ctx.dialect, catalog: ctx.catalog, schemas: ctx.schemas };
    const tablesOf = (scope: ScopeInfo): Table[] | undefined => {
      if (!ownTables.has(scope)) {
        const tables: Table[] = [];
        // A table function is a relation the scope's cut does not list, with columns of its own.
        let ok = !hasTableFunction(ctx.tokens, scope);
        for (const rel of scope.relations) {
          const table = resolveRelation(resolveContext, ctx.locals, rel)?.table;
          if (table) tables.push(table);
          else ok = false;
        }
        ownTables.set(scope, ok ? tables : undefined);
      }
      return ownTables.get(scope);
    };
    const chainTables = (scope: ScopeInfo): readonly Table[] | undefined => {
      if (!chains.has(scope)) {
        const tables: Table[] = [];
        let ok = true;
        for (let s: ScopeInfo | undefined = scope; s && ok; s = s.parent) {
          const own = tablesOf(s);
          if (own) tables.push(...own);
          else ok = false;
        }
        // A query with no table at all — `INSERT INTO t SELECT 0, x` — keeps the statement's bound,
        // the one the rule always had for it.
        chains.set(scope, ok && (tables.length > 0 || statementResolved) ? tables : undefined);
      }
      return chains.get(scope);
    };
    if (!statementResolved && ctx.relations.length === 0) return;

    // An `INSERT … SELECT`'s `ON DUPLICATE KEY UPDATE` sits in the `SELECT`'s scope, but it is the
    // target's columns it assigns, and the target belongs to the `INSERT`'s scope beside it.
    const odku = onDuplicateKeyUpdate(ctx.tokens, ctx.statement.from, ctx.statement.to);
    const insertScope = odku !== undefined && ctx.inserts.length > 0 ? ctx.scopeAt(ctx.inserts[0]!) : undefined;

    const ctes = cteNames(ctx.dialect, ctx.tokens, ctx.statement.from, ctx.statement.to);
    const outputAliases = selectOutputAliases(ctx);
    const setTargets = statementSetTargets(ctx.tokens, ctx.statement.from, ctx.statement.to);
    const what = ctx.body ? "unknown column or variable" : "unknown column";

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!bareColumnCandidate(ctx.tokens, i)) continue;
      if (setTargets.has(i)) continue;
      // A name in no query at all — the bare part of an `IF` condition — keeps the statement's bound.
      const scope = ctx.scopeAt(i);
      let tables = scope ? chainTables(scope) : statementResolved ? ctx.resolved : undefined;
      if (tables && odku !== undefined && i > odku && insertScope && insertScope !== scope) {
        const target = tablesOf(insertScope);
        tables = target ? [...tables, ...target] : undefined;
      }
      if (!tables) continue;
      if (knownBareName(ctx, i, outputAliases, ctes, tables)) continue;

      const token = ctx.tokens[i]!;
      ctx.report(token, `${what}: ${token.v}`);
    }
  },
};

function hasTableFunction(tokens: readonly Token[], scope: ScopeInfo): boolean {
  for (let i = scope.from; i < scope.to; i++) {
    if (kw(tokens[i], "JSON_TABLE") && punct(tokens[i + 1], "(")) return true;
  }
  return false;
}

/** Index of the `UPDATE` of an `ON DUPLICATE KEY UPDATE`, if the statement has one. */
function onDuplicateKeyUpdate(tokens: readonly Token[], from: number, to: number): number | undefined {
  for (let i = from; i + 3 <= to; i++) {
    if (kw(tokens[i], "ON") && kw(tokens[i + 1], "DUPLICATE") && kw(tokens[i + 2], "KEY") && kw(tokens[i + 3], "UPDATE")) {
      return i + 3;
    }
  }
  return undefined;
}
