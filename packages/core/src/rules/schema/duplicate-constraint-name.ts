import { constraintOwners } from "../../catalog/catalog.ts";
import type { Rule } from "../rule.ts";
import { joinNames } from "../support.ts";

/** The key this rule's derivation is filed under, so a second asker pays nothing. */
const OWNERS = "constraint-owners";

export const duplicateConstraintName: Rule = {
  id: "schema/duplicate-constraint-name",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `Two tables declaring a foreign key by the same name.

**MySQL scopes a constraint name to the database, not to the table.** The second \`CREATE TABLE\` is
refused — errno 121, *Duplicate key on write or update* — so a repository holding both is a repository
that cannot be applied to an empty server in the order it is written.

It comes of the most ordinary gesture there is: copying a table's DDL to start a new one and changing
everything except the constraint name. Nothing in the file that was copied *from* changes, nothing in
the file that was copied *to* looks wrong, and each is valid read on its own. Only something holding
the whole schema at once can see the collision, which is why the catalog answers this and no single
table can.

**A dump of a live server will not contain this**, because the server would not have accepted it. The
file it is waiting for is the one somebody wrote by hand, or the migration about to be applied — and
that is exactly where it is cheapest to catch.

Two tables of the same name are not this: a repository defining a table twice is a different problem,
and the catalog's own duplicate report is where it belongs.`,

  check(ctx) {
    const owners = ctx.catalog.index(OWNERS, (tables) => constraintOwners(ctx.dialect, tables));

    for (const fk of ctx.table.foreignKeys) {
      if (!fk.name || fk.columnSpans.length === 0) continue;
      const declared = owners.get(ctx.dialect.foldIdentifier(fk.name, false));
      if (!declared || declared.length < 2) continue;

      const others = declared.filter((name: string) => name !== ctx.table.name);
      if (others.length === 0) continue;

      ctx.report(
        fk.columnSpans[0]!,
        `the name ${fk.name} is already a constraint of ${joinNames(others)}, and MySQL scopes it to ` +
          "the database rather than the table",
      );
    }
  },
};
