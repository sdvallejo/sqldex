import { kwAny, punct } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

/**
 * Every integer type MySQL 8.0 warns 1681 about when it is written with a display width, its
 * synonyms included.
 */
const INT_TYPES: ReadonlySet<string> = new Set([
  "TINYINT",
  "SMALLINT",
  "MEDIUMINT",
  "MIDDLEINT",
  "INT",
  "INTEGER",
  "BIGINT",
  "INT1",
  "INT2",
  "INT3",
  "INT4",
  "INT8",
]);

export const integerDisplayWidth: Rule = {
  id: "compat/integer-display-width",
  group: "compat",
  severity: "warn",
  scope: "document",
  dialects: ["mysql"],
  docs: `An integer type written with a display width — \`INT(11)\`, \`BIGINT(20) UNSIGNED\`,
\`TINYINT(1)\` — on a column, an \`ALTER TABLE\`, a routine's parameter or \`RETURNS\`, or a \`DECLARE\`d
local.

MySQL 8.0 answers every one of these with warning 1681, "Integer display width is deprecated and
will be removed in a future release." Like any warning, it goes to a client that nobody reads, once
per \`CREATE\`, while the width stays in the file. The finding says it once, in the file, where the fix
is. The width does not change what the column holds — \`INT(5)\` and \`INT(11)\` accept the same range,
and \`TINYINT(1)\` stores 127 — so \`INT\` alone declares the same thing without the notice.

**\`TINYINT(1)\` earns the warning too, but no quick fix.** Unlike every other width, its \`(1)\` is not
invisible: \`SHOW CREATE TABLE\` keeps printing \`tinyint(1)\` where it drops \`int(11)\` down to \`int\`, and
selecting a \`TINYINT(1)\` column or local reports a result-metadata length of 1 instead of 4. Removing
the \`(1)\` changes what a client reading that metadata sees, so the rule still reports it, like any
other width, but leaves the edit to whoever reads the finding.

\`ZEROFILL\` gets its own, separate 1681 ("The ZEROFILL attribute is deprecated…") and is out of scope
here; this rule neither flags it nor removes it — a column declared with both keeps being flagged for
its width, and its quick fix stands down rather than touch one half of a pair the server is retiring
together.

MariaDB does not deprecate this: its \`SHOW CREATE TABLE\` still prints \`int(11)\` unchanged. sqldex has
only the \`mysql\` dialect, so a MariaDB project silences \`compat/integer-display-width\` in
\`.sqldex.json\`, the same as the sql_mode rules in \`query/write-value-invalid-for-type\` do.`,

  check(ctx) {
    const tokens = ctx.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const word = kwAny(tokens[i], INT_TYPES);
      if (!word) continue;
      if (!punct(tokens[i + 1], "(")) continue;

      const width = tokens[i + 2];
      if (!width || width.t !== "num") continue;
      if (!punct(tokens[i + 3], ")")) continue;

      ctx.report(
        { s: tokens[i]!.s, e: tokens[i + 3]!.e },
        `${word}(${width.v}): integer display width is deprecated in MySQL 8.0; write ${word}`,
      );
    }
  },
};
