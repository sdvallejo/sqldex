import { relations } from "../../syntax/fast/stmt.ts";
import { kw, kwAny, matchingParen, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/** Clauses that end a `JOIN`'s condition slot. */
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

export const joinWithoutCondition: Rule = {
  id: "query/join-without-condition",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: `A \`JOIN\` with neither \`ON\` nor \`USING\`, between two tables of the schema.

An inner join with no condition is a cartesian product. On two real tables that is catastrophic, and
almost always a condition somebody forgot.

**Two guards, and each earns its keep:**

  - **Walk to the clause boundary, skipping each subquery whole.** Looking a fixed number of tokens
    ahead for the \`ON\` does not work: in \`LEFT JOIN (SELECT …) x ON …\` the condition sits after the
    closing parenthesis, sometimes dozens of lines below, and a fixed window never reaches it.
  - **Both sides must be tables of the catalog**, and the left-hand one must come first. What this
    drops is one deliberate idiom, over and over: joining two single-row aggregate tables the
    procedure has just built, unconditionally and on purpose. The distinction is real rather than
    fitted — a relation you constructed yourself and then join unconditionally is a choice, while two
    tables of the schema crossed with no condition almost never is.

\`CROSS JOIN\` and \`NATURAL JOIN\` are excluded: both are valid with no condition, and the first is how
you say you meant it.`,

  check(ctx) {
    const isSchemaTable = (name: string | undefined): boolean => {
      if (!name) return false;
      const key = ctx.dialect.foldIdentifier(name, false);
      if (ctx.catalog.tempTable(name) || ctx.locals.byName.has(key)) return false;
      return ctx.catalog.table(name) !== undefined;
    };

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      if (!kw(ctx.tokens[i], "JOIN")) continue;

      const before = ctx.tokens[i - 1];
      const kind = before?.t === "id" && !before.q ? before.v.toUpperCase() : "";
      if (kind === "CROSS" || kind === "NATURAL") continue;

      let found = false;
      let k = i + 1;
      while (k <= ctx.statement.to) {
        const t = ctx.tokens[k]!;
        if (punct(t, "(")) {
          const close = matchingParen(ctx.tokens, k);
          k = (close === -1 ? ctx.statement.to : close) + 1;
        } else if (kw(t, "ON") || kw(t, "USING")) {
          found = true;
          break;
        } else if (kwAny(t, JOIN_BOUNDARY) !== undefined || punct(t, ";")) {
          break;
        } else {
          k++;
        }
      }
      if (found) continue;

      const joined = relations(ctx.dialect, ctx.tokens, i, Math.min(i + 16, ctx.statement.to))[0];
      if (!joined || !isSchemaTable(joined.name)) continue;

      const leftIsSchema = ctx.relations.some(
        (relation) => relation.offset < joined.offset && isSchemaTable(relation.name),
      );
      if (!leftIsSchema) continue;

      ctx.report(
        ctx.tokens[i]!,
        `this JOIN with ${joined.name} has no ON or USING: it is a cartesian product`,
      );
    }
  },
};
