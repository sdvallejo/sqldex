import { SYSTEM_SCHEMAS } from "../shared/names.ts";
import type { Column } from "../../model/table.ts";
import type { Rule } from "../rule.ts";
import { fkLabel } from "./fk-unknown-table.ts";

/** Types written more than one way, folded to the one the comparison uses. */
const SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["integer", "int"],
  ["dec", "decimal"],
  ["numeric", "decimal"],
  ["fixed", "decimal"],
  ["bool", "tinyint"],
  ["boolean", "tinyint"],
]);

/** Types whose declared width is a display width, which MySQL 8 ignores. */
const INTEGER: ReadonlySet<string> = new Set(["int", "bigint", "smallint", "tinyint", "mediumint"]);

/** Types whose length may differ across a key, and whose collation may not. */
const CHARACTER: ReadonlySet<string> = new Set([
  "char",
  "varchar",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "enum",
  "set",
]);

function base(column: Column): string {
  const name = column.type.name.toLowerCase();
  return SYNONYMS.get(name) ?? name;
}

/**
 * What InnoDB would object to about this pair, said in the words a fix needs — or `undefined` when
 * it would accept them.
 *
 * The three shapes it treats differently, and each of them is a way of being wrong on its own:
 *
 *   - **Integers** are compared without their width, because `int(11)` and `int` are one type and
 *     saying otherwise would report every schema dumped by an older server. What must match is the
 *     **sign**: `int` and `int unsigned` hold different numbers and InnoDB says so.
 *   - **Character types** may differ in length — a `varchar(20)` key can reference a `varchar(40)`
 *     — and may not differ in collation, which is where the comparison actually happens. When
 *     either collation is unknown the pair is left alone: "I cannot tell" is not a finding.
 *   - **Everything else**, decimals above all, is compared with its arguments: `decimal(10,2)` and
 *     `decimal(12,2)` are a different size, and for fixed-precision types InnoDB demands the same.
 */
function objection(own: Column, ref: Column): { mine: string; theirs: string } | undefined {
  if (base(own) !== base(ref)) return { mine: own.type.raw, theirs: ref.type.raw };

  if (INTEGER.has(base(own))) {
    if ((own.type.unsigned ?? false) !== (ref.type.unsigned ?? false)) {
      return { mine: own.type.raw, theirs: ref.type.raw };
    }
    return undefined;
  }

  if (CHARACTER.has(base(own))) {
    // The value list is part of the type for these two, not a length.
    if ((base(own) === "enum" || base(own) === "set") && own.type.args.join() !== ref.type.args.join()) {
      return { mine: own.type.raw, theirs: ref.type.raw };
    }
    if (!own.collation || !ref.collation || own.collation === ref.collation) return undefined;
    return { mine: `collated ${own.collation}`, theirs: `collated ${ref.collation}` };
  }

  if (own.type.args.join() !== ref.type.args.join()) return { mine: own.type.raw, theirs: ref.type.raw };
  return undefined;
}

export const fkTypeMismatch: Rule = {
  id: "schema/fk-type-mismatch",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `A foreign key whose column is not the same type as the column it references.

InnoDB does not accept it. The two ends of a key are compared value against value, so their types
have to agree: the same kind, the same sign, and for a fixed-precision type the same size. A key that
does not satisfy that is rejected when the table is created — errno 150, *Foreign key constraint is
incorrectly formed* — which makes this an error rather than a warning.

**Nothing else in the repository can see it.** The two tables are two files, and each is valid on its
own: the child says \`int\`, the parent says \`bigint\`, and only something holding both at once can
notice. That is also how it survives — the key was created when the types matched, one side was
widened later, and the DDL that came back out of the server records a constraint that could not be
recreated from it.

What the comparison deliberately ignores:

  - **The display width of an integer.** \`int(11)\` and \`int\` are one type, and reporting the pair
    would report every schema dumped by an older server. The **sign** is not ignored: \`int\` and
    \`int unsigned\` hold different numbers.
  - **The length of a character type.** A \`varchar(20)\` may reference a \`varchar(40)\`; MySQL asks
    only that the collation match, because that is where the comparison happens. If either collation
    is unknown, the pair is left alone rather than guessed at.

And what it leaves to its neighbours: a key whose table or column does not exist is
\`schema/fk-unknown-table\` and \`schema/fk-unknown-column\`'s finding, and this says nothing about a
pair it could not resolve — two complaints about one line read as two problems.`,

  check(ctx) {
    for (const fk of ctx.table.foreignKeys) {
      if (!fk.refTable || SYSTEM_SCHEMAS.has(fk.refTable.toLowerCase())) continue;
      const target = ctx.catalog.table(fk.refTable);
      if (!target) continue;

      fk.columns.forEach((name, position) => {
        const span = fk.columnSpans[position];
        const refName = fk.refColumns[position];
        // A key with a different number of columns on each end is a different defect, and this is
        // not the rule that has anything to say about it.
        if (!span || refName === undefined) return;

        const own = ctx.table.byName.get(ctx.dialect.foldIdentifier(name, false));
        const ref = target.byName.get(ctx.dialect.foldIdentifier(refName, false));
        if (!own || !ref) return;

        const problem = objection(own, ref);
        if (problem) {
          ctx.report(
            span,
            `${fkLabel(fk.name)}: ${name} is ${problem.mine}, and ${target.name}.${ref.name} is ` +
              `${problem.theirs} — InnoDB refuses the constraint`,
          );
        }
      });
    }
  },
};
