import type { Span } from "../../syntax/types.ts";
import type { Rule } from "../rule.ts";

export const indexUnknownColumn: Rule = {
  id: "schema/index-unknown-column",
  group: "schema",
  severity: "error",
  scope: "table",
  docs: `An index, or a primary key, over a column the table does not have.

Same shape and same reasoning as the dangling-foreign-key rules: unambiguous, free, and rejected by
the engine outright. Covers the \`PRIMARY KEY\` and every secondary index alike.

The length prefix of a partial index — \`KEY ix_payload (payload(10))\` — is a length and not a
column, and is not read as one.`,

  check(ctx) {
    const missing = (names: readonly string[], spans: readonly Span[], label: string): void => {
      names.forEach((name, position) => {
        const span = spans[position];
        if (span && !ctx.table.byName.get(ctx.dialect.foldIdentifier(name, false))) {
          ctx.report(span, `${label} names ${name}, which ${ctx.table.name} does not have`);
        }
      });
    };

    missing(ctx.table.primaryKey, ctx.table.primaryKeySpans, "the primary key");
    for (const index of ctx.table.indexes) {
      missing(index.columns, index.columnSpans, index.name ? `index ${index.name}` : "an index");
    }
  },
};
