import type { Rule } from "../rule.ts";

/** The one engine that counts per group, and therefore takes the column anywhere in a key. */
const COMPOSITE_COUNTER_ENGINE = "myisam";

export const autoIncrementNotKey: Rule = {
  id: "schema/auto-increment-not-key",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `An \`AUTO_INCREMENT\` column that is not the start of a key.

MySQL will not create the table: error 1075, *there can be only one auto column and it must be
defined as a key*. The counter is read off an index — the server asks the index for the largest
value so far — so a column with no index behind it has nothing to count from.

Two shapes fail, and they are told apart because one of them is legal on one engine:

  - **In no key at all.** Refused by every engine, MyISAM included, and that is checked rather than
    assumed.
  - **In a key, but never as its first column.** \`PRIMARY KEY (branch_id, ticket_no)\` with
    \`ticket_no AUTO_INCREMENT\` is refused by InnoDB and by MEMORY — and **accepted by MyISAM**,
    where it is a documented feature: the counter restarts per \`branch_id\`, which is how per-group
    numbering is written. So this half is reported only where the table says it is not MyISAM,
    and the engine comes from the table's own \`ENGINE=\` rather than from an assumption about what
    the server's default is.

A column-level \`PRIMARY KEY\` or \`UNIQUE\` counts, of course — \`id int AUTO_INCREMENT PRIMARY KEY\`
is the commonest well-formed spelling there is.

**A server's own dump cannot contain either shape**, since the server would have refused the
\`CREATE TABLE\`. What this guards is DDL edited by hand and migrations that have not run yet: a
composite key reordered, or a column list rewritten, turns a working table into one that no longer
creates — and the failure lands on whoever applies it.`,

  check(ctx) {
    const auto = ctx.table.columns.filter((column) => column.autoIncrement);
    if (auto.length === 0) return;

    const fold = (name: string): string => ctx.dialect.foldIdentifier(name, false);
    const keys = [ctx.table.primaryKey, ...ctx.table.indexes.map((index) => index.columns)].filter(
      (columns) => columns.length > 0,
    );
    const engine = ctx.table.extras?.engine;
    const myisam = typeof engine === "string" && engine.toLowerCase() === COMPOSITE_COUNTER_ENGINE;

    for (const column of auto) {
      const key = fold(column.name);
      if (keys.some((columns) => fold(columns[0]!) === key)) continue;

      const buried = keys.some((columns) => columns.some((name) => fold(name) === key));
      if (buried) {
        // MyISAM counts per group off a composite key, so there the column belongs where it is.
        if (myisam) continue;
        ctx.report(
          column.nameSpan,
          `${column.name} is AUTO_INCREMENT but never the first column of a key: MySQL refuses this table`,
        );
      } else {
        ctx.report(
          column.nameSpan,
          `${column.name} is AUTO_INCREMENT and is in no key: MySQL refuses this table`,
        );
      }
    }
  },
};
