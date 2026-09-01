import type { Relation } from "../../model/query.ts";
import { setClause } from "../shared/columns.ts";
import { kw, kwAny, punct, splitCommas } from "../../syntax/fast/tok.ts";
import type { Rule, ScopeInfo, StatementContext } from "../rule.ts";

/** Words that may sit between `DELETE` and the tables it names. */
const DELETE_MODIFIERS: ReadonlySet<string> = new Set(["LOW_PRIORITY", "QUICK", "IGNORE"]);

/** A relation that names a catalog table, rather than a derived table or a `WITH`. */
function isTable(relation: Relation): boolean {
  return relation.name !== undefined && relation.cte !== true && relation.derived === undefined;
}

/**
 * The same table on both sides, spelled either way.
 *
 * Qualification has to match, and that is a guard rather than an oversight: `orders` and
 * `archive.orders` are the same table only if `archive` is the schema this file runs in, which no
 * `.sql` in a repository says. Two different names for one table are worth missing; accusing a
 * statement that reads a genuinely different schema's table is not.
 */
function sameTable(ctx: StatementContext, a: Relation, b: Relation): boolean {
  const fold = (name: string, quoted?: boolean): string => ctx.dialect.foldIdentifier(name, quoted === true);
  if (!a.name || !b.name) return false;
  if (fold(a.name, a.quoted) !== fold(b.name, b.quoted)) return false;
  if ((a.schema === undefined) !== (b.schema === undefined)) return false;
  return a.schema === undefined || b.schema === undefined || fold(a.schema) === fold(b.schema);
}

/**
 * What an `UPDATE` writes: the tables its `SET` assigns to, which is not the same as the tables it
 * reads.
 *
 * With one relation there is nothing to decide. With a join, only the qualifiers say which of them
 * is the destination — `UPDATE orders o JOIN customers c ON … SET o.status = 'A'` writes `orders`
 * alone, and reading `customers` in a subquery of it is something MySQL allows. A bare column name
 * in that position could belong to either table, so the whole statement is left alone.
 */
function updateTargets(ctx: StatementContext, scope: ScopeInfo): Relation[] {
  const tables = scope.relations.filter(isTable);
  if (tables.length <= 1) return tables;

  const set = setClause(ctx);
  if (set.from === -1) return [];

  const targets: Relation[] = [];
  for (const span of splitCommas(ctx.tokens, set.from + 1, set.to - 1)) {
    const name = ctx.tokens[span.from];
    if (name?.t !== "id" || !punct(ctx.tokens[span.from + 1], ".")) return [];
    const relation = scope.byAlias.get(ctx.dialect.foldIdentifier(name.v, name.q === true));
    if (relation && isTable(relation) && !targets.includes(relation)) targets.push(relation);
  }
  return targets;
}

/**
 * What a `DELETE` empties.
 *
 * `DELETE FROM orders …` names it once and is the whole of the ordinary case. The multi-table form
 * names its targets before the `FROM` — `DELETE o FROM orders o JOIN customers c …` — and there the
 * list is the statement's own answer to which of the joined tables it is deleting from.
 */
function deleteTargets(ctx: StatementContext, scope: ScopeInfo): Relation[] {
  const tables = scope.relations.filter(isTable);
  if (tables.length <= 1) return tables;

  const targets: Relation[] = [];
  let i = ctx.statement.from + 1;
  while (kwAny(ctx.tokens[i], DELETE_MODIFIERS)) i++;
  for (; i <= ctx.statement.to && !kw(ctx.tokens[i], "FROM"); i++) {
    const t = ctx.tokens[i]!;
    // `DELETE o.* FROM …` writes the same target the bare alias would; the `.*` says no more.
    if (t.t !== "id" || punct(ctx.tokens[i - 1], ".")) continue;
    const relation = scope.byAlias.get(ctx.dialect.foldIdentifier(t.v, t.q === true));
    if (relation && isTable(relation) && !targets.includes(relation)) targets.push(relation);
  }
  return targets;
}

/**
 * Is this scope separated from the write by a derived table?
 *
 * `FROM (SELECT … FROM orders) x` is a query MySQL runs on its own before the write starts, and it
 * is the standard way of writing what the error refuses — so everything below such a parenthesis is
 * out of reach of this rule, however deeply the reference sits inside it.
 */
function behindDerivedTable(scope: ScopeInfo, writeScope: ScopeInfo): boolean {
  for (let at: ScopeInfo | undefined = scope; at && at !== writeScope; at = at.parent) {
    const parent = at.parent;
    if (!parent) break;
    if (parent.relations.some((r) => r.derived && r.derived.from <= at!.from && at!.from <= r.derived.to)) {
      return true;
    }
  }
  return false;
}

/** Every scope nested in the write's own, in source order and without the ones it cannot reach. */
function subqueryScopes(ctx: StatementContext, writeScope: ScopeInfo): ScopeInfo[] {
  const found: ScopeInfo[] = [];
  const seen = new Set<ScopeInfo>();
  for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
    const scope = ctx.scopeAt(i);
    if (!scope || scope === writeScope || seen.has(scope)) continue;
    seen.add(scope);

    let inside = false;
    for (let at: ScopeInfo | undefined = scope.parent; at; at = at.parent) {
      if (at === writeScope) {
        inside = true;
        break;
      }
    }
    if (inside && !behindDerivedTable(scope, writeScope)) found.push(scope);
  }
  return found;
}

export const writeTargetInSubquery: Rule = {
  id: "query/write-target-in-subquery",
  group: "query",
  severity: "error",
  scope: "statement",
  dialects: ["mysql"],
  docs: `An \`UPDATE\` or \`DELETE\` with a subquery that reads the very table being written.

MySQL refuses it: *error 1093, You can't specify target table 'x' for update in FROM clause*, and the
statement does not run at all. Not slowly, not on some rows — the server rejects it outright, so
\`UPDATE orders SET status = 'A' WHERE order_id IN (SELECT order_id FROM orders WHERE …)\` is a
statement that has never worked and never will.

**It is worth a linter precisely because it is a hard error.** A statement that always fails cannot
survive in code that runs, so what this rule finds is code on its way to production and not yet
there: a correction script, a migration, a procedure being written. The reader of the file has no
way to tell — the query is ordinary SQL, and the same shape is perfectly legal in a \`SELECT\`.

And it is legal on other servers. MariaDB accepts these statements, so a query developed and tried
there is one that fails the first time it is run against MySQL. That is exactly the case where the
error arrives far from the person who wrote it.

The fix is to put the read behind something MySQL evaluates on its own — \`… IN (SELECT id FROM
(SELECT order_id AS id FROM orders WHERE …) x)\` — or to rewrite the subquery as a join, which is
usually what the statement meant anyway.

What it does not report, and why:

  - **A derived table**, \`FROM (…) x\`, at any depth inside it. That is the accepted workaround, not
    the defect.
  - **A common table expression.** \`WITH recent AS (SELECT … FROM orders) UPDATE orders …\` is
    likewise something MySQL runs.
  - **A table that is joined but not written.** In \`UPDATE orders o JOIN customers c ON … SET
    o.status = 'A'\`, only \`orders\` is the target; a subquery reading \`customers\` is fine, and the
    same holds for the tables a multi-table \`DELETE\` does not name.
  - **A multi-table \`UPDATE\` whose \`SET\` assigns to a bare column name**, where nothing says which
    of the joined tables is the one being written.
  - **A correlated reference to the row being written.** \`UPDATE tmp_totals SET amount = (SELECT
    SUM(l.amount) FROM order_lines l WHERE l.order_id = tmp_totals.order_id)\` names the target only
    as a qualifier, never in the subquery's \`FROM\`, and MySQL runs it.
  - **A different schema, or one side qualified and the other not.** \`archive.orders\` and \`orders\`
    are the same table only if the file runs in \`archive\`, which no \`.sql\` in a repository states.
  - **\`INSERT … SELECT\` reading its own target**, which MySQL allows and which is therefore a
    different question entirely.

A temporary table is the one case where the wording changes and the verdict does not: MySQL cannot
open one twice in a single statement, so the same shape comes back as *error 1137, Can't reopen
table* instead.`,

  check(ctx) {
    const head = ctx.tokens[ctx.statement.from];
    const isUpdate = kw(head, "UPDATE");
    const isDelete = kw(head, "DELETE");
    if (!isUpdate && !isDelete) return;

    const writeScope = ctx.scopeAt(ctx.statement.from);
    if (!writeScope) return;

    const targets = isUpdate ? updateTargets(ctx, writeScope) : deleteTargets(ctx, writeScope);
    if (targets.length === 0) return;

    const verb = isUpdate ? "UPDATE" : "DELETE";
    for (const scope of subqueryScopes(ctx, writeScope)) {
      for (const read of scope.relations) {
        if (!isTable(read) || !read.nameSpan) continue;
        const target = targets.find((t) => sameTable(ctx, t, read));
        if (!target) continue;

        const name = target.name!;
        const temporary =
          ctx.locals.byName.get(ctx.dialect.foldIdentifier(name, target.quoted === true))?.kind === "temp_table" ||
          ctx.catalog.tempTable(name) !== undefined;
        const failure = temporary
          ? "MySQL cannot open a temporary table twice in one statement (error 1137)"
          : "MySQL rejects the statement with error 1093";
        ctx.report(read.nameSpan, `this ${verb} writes ${name}, and this subquery reads it: ${failure}`);
      }
    }
  },
};
