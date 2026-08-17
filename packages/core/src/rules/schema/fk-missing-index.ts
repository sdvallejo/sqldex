import type { Table } from "../../model/table.ts";
import type { Rule } from "../rule.ts";
import { isLeftPrefix, SYSTEM_SCHEMAS } from "../support.ts";
import { fkLabel } from "./fk-unknown-table.ts";

/** The target's keys, in the order worth trying them: the primary key, then each index. */
function keysOf(target: Table): { name: string; columns: readonly string[] }[] {
  const keys: { name: string; columns: readonly string[] }[] = [];
  if (target.primaryKey.length > 0) keys.push({ name: "PRIMARY KEY", columns: target.primaryKey });
  for (const index of target.indexes) {
    keys.push({ name: index.name ? `index ${index.name}` : "an index", columns: index.columns });
  }
  return keys;
}

export const fkMissingIndex: Rule = {
  id: "schema/fk-missing-index",
  group: "schema",
  severity: "warn",
  scope: "table",
  docs: `A foreign key whose referenced columns no index on the target begins with.

InnoDB checks the constraint by looking the parent row up on those columns, and it can only use an
index that **starts** with them. Without one, every insert and update on the child table does more
work than it looks like it does — and it is invisible in the DDL, because the constraint is declared
and accepted either way.

**The comparison is position by position**, not as sets and certainly not as the names joined
together. An index over the same columns in the other order is the common version of this mistake,
and a set comparison would call it covered — which is the same bug the rule exists to find.

When such an index does exist, the message names it, because "the index you have is reversed" and
"there is no index" are different fixes.

It stands down when one of the referenced columns does not exist:
\`schema/fk-unknown-column\` has already said something more useful about that line.`,

  check(ctx) {
    for (const fk of ctx.table.foreignKeys) {
      if (fk.refColumns.length === 0 || !fk.refTable || !fk.refTableSpan) continue;
      if (SYSTEM_SCHEMAS.has(fk.refTable.toLowerCase())) continue;

      const target = ctx.catalog.table(fk.refTable);
      if (!target) continue;

      // Checked here rather than left to rule ordering: a rule that only works when another one
      // ran first is a rule that breaks the day somebody turns that other one off.
      const allExist = fk.refColumns.every((name) =>
        target.byName.has(ctx.dialect.foldIdentifier(name, false)),
      );
      if (!allExist) continue;

      let reversed: string | undefined;
      let covered = false;
      for (const key of keysOf(target)) {
        if (isLeftPrefix(fk.refColumns, key.columns)) {
          covered = true;
          break;
        }
        // Same columns, different order: worth naming, and only the first such key is.
        if (key.columns.length === fk.refColumns.length && reversed === undefined) {
          const present = new Set(key.columns.map((name) => name.toLowerCase()));
          if (fk.refColumns.every((name) => present.has(name.toLowerCase()))) {
            reversed = `${key.name} is (${key.columns.join(", ")}), the other way round`;
          }
        }
      }
      if (covered) continue;

      const reason = reversed ?? `no index on ${target.name} starts with them`;
      const label = fkLabel(fk.name);
      ctx.report(
        fk.refTableSpan,
        `${label} references ${target.name} (${fk.refColumns.join(", ")}): ${reason}`,
      );
    }
  },
};
