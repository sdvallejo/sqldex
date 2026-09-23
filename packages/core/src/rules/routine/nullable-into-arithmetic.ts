import { ARITHMETIC, insideNullSafe } from "../shared/nulls.ts";
import { nullableSources, originClause } from "../shared/taint.ts";
import { assignmentTargets } from "../shared/writes.ts";
import { punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const nullableIntoArithmetic: Rule = {
  id: "routine/nullable-into-arithmetic",
  group: "routine",
  // `a + v != b` is one read next to an operator and next to a negation. The NULL escapes through
  // the sum before the comparison ever sees it, so the sum is where the reader has to look — and the
  // same holds for `CONCAT(v + 1)`.
  supersedes: ["routine/nullable-variable-in-predicate", "routine/nullable-variable-in-concat"],
  severity: "warn",
  scope: "routine",
  docs: `A nullable column, an aggregate, or a lookup-turned-search — reaching arithmetic through a variable.

The same defect as a nullable column entering an expression directly, with one hop added: the column
passes through a \`SELECT … INTO v\` first. The catalog knows the column is nullable, so the variable
inherits it — and then \`v * rate\` is NULL for the whole expression, with no error anywhere.

The \`SELECT\` list is matched to the \`INTO\` list **by position**, the way MySQL assigns them. A slot
holding an expression taints nothing, and neither does a column from a relation that did not resolve:
a variable is tainted from a column the catalog says is nullable, or from the same two shapes
\`query/nullable-scalar-subquery\` reports directly — an aggregate other than \`COUNT\`, unprotected by
an inner \`COALESCE\`/\`IFNULL\`, or a search rather than a lookup of one row by its key — read into it
by \`SET v = (SELECT …)\` or an aggregate slot of a \`SELECT … INTO\` with no \`GROUP BY\`. A plain
\`SELECT col INTO v\` that matches nothing leaves \`v\` **unchanged**, not NULL, so that shape alone
taints nothing.

**What it does not model:** a later assignment from a source that cannot be NULL does not clear the
taint, because that needs the flow analysis \`routine/variable-never-assigned\` deliberately stops
short of. The exchange is worth naming — the rule can be wrong about a variable that was tainted and
then fixed, and in return it is never wrong about what tainted it.

A read wrapped in \`COALESCE\` / \`IFNULL\` / \`IF\` is not reported: that is the fix.

**A no-rows source is reported once, not at every read.** Every later read of such a variable
names the same aggregate or the same search, and the fix is inside it — a \`COALESCE(SUM(…), 0)\`, or
a \`WHERE\` that pins a key — which clears every read at once. So only the first read, in the order
the routine is written, is reported. A nullable column has no single place to fix, since it stays
nullable wherever it is read, so that source is still reported at every read.`,

  check(ctx) {
    const tainted = nullableSources(ctx);
    if (tainted.size === 0) return;

    const { written } = assignmentTargets(ctx);
    // Only the no-rows source is deduplicated: see the doc paragraph above.
    const reportedEmpty = new Set<string>();

    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      if (t.t !== "id" || t.q || written.has(i) || punct(ctx.tokens[i - 1], ".")) return;
      const name = ctx.dialect.foldIdentifier(t.v, false);
      const origin = tainted.get(name);
      if (!origin) return;

      const before = ctx.tokens[i - 1];
      const after = ctx.tokens[i + 1];
      const inArithmetic =
        (before?.t === "punct" && ARITHMETIC.has(before.v)) ||
        (after?.t === "punct" && ARITHMETIC.has(after.v));
      if (!inArithmetic || insideNullSafe(ctx.tokens, i)) return;

      if (origin.kind === "empty") {
        if (reportedEmpty.has(name)) return;
        reportedEmpty.add(name);
      }

      ctx.report(t, `${originClause(t.v, origin)}; without COALESCE the whole expression is NULL`);
    });
  },
};
