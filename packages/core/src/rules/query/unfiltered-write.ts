import { kw, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const unfilteredWrite: Rule = {
  id: "query/unfiltered-write",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `An \`UPDATE\` or \`DELETE\` with nothing to narrow it.

It rewrites or empties the whole table, and it looks exactly like the version that had a \`WHERE\`
somebody deleted by accident.

**The guards are what make it usable**, and without them this rule is mostly complaints about
deliberate code:

  - **A \`JOIN\` or a \`USING\` already narrows the write.** \`UPDATE accounts INNER JOIN tmp_batch USING
    (account_id) SET …\` is the ordinary way of updating a set of rows, not an accidental mass update.
  - **A \`LIMIT\` bounds it** too.
  - **A temporary table is emptied wholesale on purpose**; that is what it is for.

Only clauses at parenthesis depth zero count: the \`WHERE\` of a subquery narrows the subquery, not this
statement.

What survives is usually right, and where it is not — a table genuinely meant to be emptied — the
answer is \`-- sqldex:ignore query/unfiltered-write\` rather than a looser rule.`,

  check(ctx) {
    const head = ctx.tokens[ctx.statement.from];
    const isUpdate = kw(head, "UPDATE");
    const isDelete = kw(head, "DELETE");
    if (!isUpdate && !isDelete) return;

    let depth = 0;
    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const t = ctx.tokens[i]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && (kw(t, "WHERE") || kw(t, "JOIN") || kw(t, "USING") || kw(t, "LIMIT"))) {
        return;
      }
    }

    let at = ctx.statement.from + 1;
    if (isDelete && kw(ctx.tokens[at], "FROM")) at++;
    const nameToken = ctx.tokens[at];
    if (!nameToken || nameToken.t !== "id") return;

    const key = ctx.dialect.foldIdentifier(nameToken.v, nameToken.q ?? false);
    if (ctx.locals.byName.has(key) || ctx.catalog.tempTable(nameToken.v)) return;

    const verb = isDelete ? "DELETE" : "UPDATE";
    const effect = isDelete ? "empties" : "rewrites";
    ctx.report(nameToken, `this ${verb} has no filter: it ${effect} the whole of ${nameToken.v}`);
  },
};
