# @sqldex/lsp

*Gotta index 'em all!*

The [sqldex](https://github.com/sdvallejo/sqldex) engine as a language server, so your editor reads
a repository of MySQL `.sql` files as the database schema it is. No database connection, no
credentials, nothing running: the catalog is built from the files themselves.

```sh
npm install -g @sqldex/lsp
sqldex-lsp --stdio
```

What it answers: **findings as you type** (38 rules), **hover** — a column's type, whether it is
nullable, whether it is a key, the table its foreign key points at and the values it is allowed to
hold; a table's `CREATE TABLE`; what a two-letter alias stands for — **completion** from the
catalog, **signature help**, **goto definition** and **type definition** (a foreign key's target),
**references**, **rename** across the project, **call hierarchy**, **symbols**, **inlay hints** and
**code actions** that write statements for you.

It takes no arguments: which project it serves comes from the `initialize`, and how it behaves comes
from that project's own `.sqldex.json` — the same file `sqldex check` reads in CI.

Clients for Neovim and for VS Code ship in the repository, under `editors/`. Any other editor
needs the same three facts: run `sqldex-lsp --stdio`, attach it to SQL buffers, and give it the
project directory as the root.

**https://github.com/sdvallejo/sqldex**

MIT.
