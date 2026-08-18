import { kw } from "../../syntax/fast/tok.ts";
import type { Rule } from "../rule.ts";

export const cursorNeverOpened: Rule = {
  id: "routine/cursor-never-opened",
  group: "routine",
  severity: "warn",
  scope: "routine",
  docs: `A cursor declared and never opened.

A cursor is only useful through \`OPEN\` / \`FETCH\` / \`CLOSE\`. One that is never opened does nothing,
and in practice it is the leftover of a loop somebody rewrote as a plain query — which means the
query it declares may well still name a temporary table nothing creates any more.

One pass collects every \`OPEN <name>\` in the file, rather than scanning the file once per cursor.
The comparison is case-insensitive like everything else here, which matters more than it sounds:
\`DEClARE\` with a stray capital in the middle is exactly the kind of typo that sits in a body for
years, and it must not be what hides the finding.`,

  check(ctx) {
    const declared = ctx.locals.items.filter((item) => item.kind === "cursor");
    if (declared.length === 0) return;

    const opened = new Set<string>();
    ctx.tokens.forEach((t, i) => {
      // Only this routine's body: a file can hold two, and one's variables are not the other's.
      if (i < ctx.body.from || i > ctx.body.to) return;
      const name = ctx.tokens[i + 1];
      if (kw(t, "OPEN") && name?.t === "id") {
        opened.add(ctx.dialect.foldIdentifier(name.v, name.q ?? false));
      }
    });

    for (const item of declared) {
      if (opened.has(ctx.dialect.foldIdentifier(item.name, item.quoted))) continue;
      ctx.report(item.nameSpan, `cursor ${item.name} is declared but never opened`);
    }
  },
};
