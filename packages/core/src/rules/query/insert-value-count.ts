import { kw, punct } from "../../syntax/fast/tok.ts";
import { arity } from "../routine/call-arity.ts";
import type { Rule } from "../rule.ts";
import { insertTarget } from "./insert-target.ts";

export const insertValueCount: Rule = {
  id: "query/insert-value-count",
  group: "query",
  severity: "error",
  scope: "statement",
  docs: `An \`INSERT\` or \`REPLACE ... VALUES (...)\` whose value count does not match.

This is the error that only appears once a table gains a column and a positional \`INSERT\` falls
behind it — which is to say, long after the change that caused it, in whichever procedure nobody
thought to look at. The engine rejects it outright, so it is an error.

With an explicit column list the count is against that list; without one, against the table.

**Two counts are accepted for a table with generated columns.** A positional insert may pass a
generated column \`DEFAULT\` or leave it out entirely, and both forms are valid, so both the full
count and the stored-only count are correct. Accepting one and not the other would manufacture an
error out of a legal statement.

\`VALUES (a,b), (c,d)\` is checked tuple by tuple, because each one can be wrong on its own.`,

  check(ctx) {
    for (const insert of ctx.inserts) {
      const target = insertTarget(ctx, insert);
      if (!target) continue;

      // `expected` is what the reader is told; `accepted` is what it is compared against, which may
      // be more than one number.
      let expected: number;
      const accepted = new Set<number>();
      if (target.list) {
        expected = target.list.names.length;
        accepted.add(expected);
      } else {
        expected = target.table.columns.length;
        accepted.add(expected);
        accepted.add(target.table.columns.filter((c) => !c.generated).length);
      }

      let j = target.after;
      if (!kw(ctx.tokens[j], "VALUES") && !kw(ctx.tokens[j], "VALUE")) continue;
      j++;

      while (punct(ctx.tokens[j], "(")) {
        const given = arity(ctx.tokens, j);
        if (!given) break;
        if (!accepted.has(given.count)) {
          ctx.report(
            ctx.tokens[j]!,
            `${target.table.name} gets ${given.count} value(s) and expects ${expected}`,
          );
        }
        j = given.close + 1;
        if (punct(ctx.tokens[j], ",")) j++;
        else break;
      }
    }
  },
};
