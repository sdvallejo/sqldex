import { normaliseType } from "../../catalog/catalog.ts";
import { columnTypeCensus } from "../../catalog/catalog.ts";
import type { Rule } from "../rule.ts";

/**
 * The thresholds that turn "these differ" into "this one is wrong".
 *
 * All three are needed, and each rules out a different kind of ordinary variation: a name used
 * twice has no majority to be in the minority of; a type held by a third of the schema is not the
 * schema's answer; and a rival appearing many times is a second convention rather than a slip.
 */
const OUTLIER_SHARE = 0.8;
const OUTLIER_MAX = 2;
const OUTLIER_MIN_TOTAL = 5;

/** The key this rule's derivation is filed under, so a second asker pays nothing. */
const CENSUS = "column-types";

export const divergentType: Rule = {
  id: "schema/divergent-type",
  group: "schema",
  severity: "hint",
  scope: "table",
  docs: `The same column name typed differently in this table from all the others.

A \`description\` that is a \`varchar\` of different lengths in different tables is normal, and the
rule says nothing about it. One table disagreeing with every other is a mistake waiting to bite a
join: the comparison silently coerces, the index on one side stops being usable, and nothing ever
errors.

**Reported as an outlier, never as a difference.** Three thresholds do that work — the leading type
holds at least ${OUTLIER_SHARE * 100}% of the uses, the rival appears at most ${OUTLIER_MAX} times,
and the name is used at least ${OUTLIER_MIN_TOTAL} times in the schema. Without them the rule
reports every name whose type varies at all, most of which is deliberate.

**The display width is normalised away first.** Otherwise \`int(11)\` against \`int\` — the same type
as far as the engine is concerned — manufactures findings out of a single type, in enough places to
drown the real ones.

\`aud_\` twins and \`*Mig\` copies are left out of the tally **and** are not judged against it. An
audit column is a copy of its source's by construction, and a migration table's type is frozen
history rather than evidence about the schema as it is now.

A **hint**: the divergence may well be deliberate, and the rule cannot tell which side is the
mistake — only that one table stands alone.`,

  check(ctx) {
    // Excluded from the tally, so they must not be judged against it either.
    const key = ctx.table.name.toLowerCase();
    if (key.startsWith("aud_") || key.endsWith("mig")) return;

    const census = ctx.catalog.index(CENSUS, (tables) => columnTypeCensus(ctx.dialect, tables));

    for (const column of ctx.table.columns) {
      const types = census.get(ctx.dialect.foldIdentifier(column.name, column.quoted));
      if (!types) continue;

      const mine = normaliseType(column.type);
      let total = 0;
      let leader: string | undefined;
      let leaderCount = 0;
      for (const [kind, n] of types) {
        total += n;
        if (n > leaderCount) {
          leader = kind;
          leaderCount = n;
        }
      }

      if (total < OUTLIER_MIN_TOTAL) continue;
      if (leader === mine) continue;
      if ((types.get(mine) ?? 0) > OUTLIER_MAX) continue;
      if (leaderCount / total < OUTLIER_SHARE) continue;

      ctx.report(
        column.nameSpan,
        `${column.name} is ${mine} here and ${leader} in ${leaderCount} of the ${total} tables that have it`,
      );
    }
  },
};
