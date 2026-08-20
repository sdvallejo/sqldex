# @sqldex/syntax-antlr

A real MySQL grammar, run for one question only: **does this parse?**

[sqldex](https://github.com/sdvallejo/sqldex)'s own backend is a hand-rolled, deliberately
permissive lexer — it extracts tables, columns and routines by pattern-matching tokens, and never
detects malformed SQL. A `CREATE TABLE` missing a comma between two columns doesn't fail there; it
silently misparses, and can produce a *wrong* finding instead of no finding at all. This package
exists to catch that class of defect directly, against
[`antlr/grammars-v4`](https://github.com/antlr/grammars-v4)'s actively maintained MySQL grammar —
including the procedural half (`BEGIN`/`END`, cursors, handlers, `SIGNAL`) the fast backend's own
rules spend most of their effort on.

```ts
import { checkSyntax } from "@sqldex/syntax-antlr";

checkSyntax("CREATE TABLE foo (id int NOT NULL name varchar(50));");
// [{ span: { s: ..., e: ... }, message: "missing ',' at 'name'" }]
```

Deliberately narrow: it reports syntax errors and nothing else. No catalog, no structure, no
opinion about `sqldex`'s own suppression conventions — `@sqldex/cli` and `@sqldex/lsp` are what
turn a `SyntaxError` into a `sqldex:syntax-error` diagnostic.

## Vendored, not generated at install time

`src/generated/` is machine-generated from the grammar (see `tools/regenerate.sh` and
`THIRD_PARTY_NOTICES.md`) and committed. **`npm install` will never refresh it** — regenerating
against a newer upstream grammar release is a deliberate, manual, maintainer action, documented in
`tools/regenerate.sh` itself.

**https://github.com/sdvallejo/sqldex**

MIT, except `src/generated/` — see `THIRD_PARTY_NOTICES.md`.
