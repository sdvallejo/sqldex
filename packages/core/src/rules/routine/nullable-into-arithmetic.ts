import { punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";
import { ARITHMETIC, assignmentTargets, insideNullSafe } from "../support.ts";
import { nullableSources } from "./nullable-sources.ts";

export const nullableIntoArithmetic: Rule = {
  id: "routine/nullable-into-arithmetic",
  group: "routine",
  severity: "warn",
  scope: "document",
  docs: `A nullable column reaching arithmetic through a variable.

The same defect as a nullable column entering an expression directly, with one hop added: the column
passes through a \`SELECT … INTO v\` first. The catalog knows the column is nullable, so the variable
inherits it — and then \`v * rate\` is NULL for the whole expression, with no error anywhere.

The \`SELECT\` list is matched to the \`INTO\` list **by position**, the way MySQL assigns them. A slot
holding an expression taints nothing, and neither does a column from a relation that did not resolve:
a variable is only ever tainted from a column the catalog says is nullable.

**What it does not model:** a later assignment from a source that cannot be NULL does not clear the
taint, because that needs the flow analysis \`routine/variable-never-assigned\` deliberately stops
short of. The exchange is worth naming — the rule can be wrong about a variable that was tainted and
then fixed, and in return it is never wrong about what tainted it.

A read wrapped in \`COALESCE\` / \`IFNULL\` / \`IF\` is not reported: that is the fix.`,

  check(ctx) {
    const tainted = nullableSources(ctx);
    if (tainted.size === 0) return;

    const { written } = assignmentTargets(ctx);

    ctx.tokens.forEach((t, i) => {
      if (t.t !== "id" || t.q || written.has(i) || punct(ctx.tokens[i - 1], ".")) return;
      const origin = tainted.get(ctx.dialect.foldIdentifier(t.v, false));
      if (!origin) return;

      const before = ctx.tokens[i - 1];
      const after = ctx.tokens[i + 1];
      const inArithmetic =
        (before?.t === "punct" && ARITHMETIC.has(before.v)) ||
        (after?.t === "punct" && ARITHMETIC.has(after.v));
      if (!inArithmetic || insideNullSafe(ctx.tokens, i)) return;

      ctx.report(
        t,
        `${t.v} comes from ${origin}, which is nullable; without COALESCE the whole expression is NULL`,
      );
    });
  },
};
