import type { Span } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";
import { isLeftPrefix } from "../support.ts";

interface Key {
  name: string;
  columns: readonly string[];
  unique: boolean;
  /** Where to report it. The primary key has none, because it is never the redundant one. */
  span?: Span;
}

export const redundantIndex: Rule = {
  id: "schema/redundant-index",
  group: "schema",
  severity: "hint",
  scope: "table",
  docs: `An index whose columns another index already begins with.

It adds nothing: the longer index already serves those lookups, and this one costs a write on every
insert and update, plus its own space.

**The exemption is the whole rule.** A \`UNIQUE\` index that is a prefix of a longer one is *not*
redundant, because it imposes a constraint the longer one does not: unique on \`(user_id)\` alone is a
different promise from unique on \`(user_id, created_at)\`. Without that exemption the rule
confidently proposes deleting business constraints, which is worse than saying nothing. The reverse
case — a plain index covering exactly the same columns as a unique one — is a real finding, and the
plain one is pure cost.

The primary key takes part only as a cover, never as the redundant one: it is unique by definition
and it is not going anywhere.

Two indexes over exactly the same columns are reported once, on the later of the two, because there
is one thing to fix and not two.

A **hint** rather than a warning. Nothing is broken, and dropping an index is a decision about a live
database that a static reading of the DDL is not entitled to push — an index this rule calls
redundant may still be the one holding a query plan together.`,

  check(ctx) {
    const keys: Key[] = [];
    if (ctx.table.primaryKey.length > 0) {
      keys.push({ name: "the primary key", columns: ctx.table.primaryKey, unique: true });
    }
    for (const index of ctx.table.indexes) {
      keys.push({
        name: index.name ?? "this index",
        columns: index.columns,
        unique: index.unique,
        span: index.columnSpans[0],
      });
    }

    keys.forEach((candidate, i) => {
      if (candidate.unique || candidate.columns.length === 0 || !candidate.span) return;
      for (const [j, cover] of keys.entries()) {
        if (i === j) continue;
        // A tie between two identical indexes goes to the later one, so the pair yields one hint.
        const later = candidate.columns.length < cover.columns.length || i > j;
        if (!later || !isLeftPrefix(candidate.columns, cover.columns)) continue;
        ctx.report(
          candidate.span,
          `${candidate.name} (${candidate.columns.join(", ")}) is redundant: ` +
            `${cover.name} already begins with those columns`,
        );
        return;
      }
    });
  },
};
