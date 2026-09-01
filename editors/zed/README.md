# sqldex for Zed

*Gotta index 'em all!*

A repository full of `CREATE TABLE` and `CREATE PROCEDURE` files **is** a database schema, and this
makes Zed read it as one. Open a stored procedure and every table in the project is already known —
its columns, their types, which ones are nullable, where each foreign key leads, and the values a
one-letter status column is allowed to hold. No database connection, no credentials, nothing
running: the catalog is built from the `.sql` files themselves.

If you have used **DataGrip's DDL data source** — point the IDE at a directory of `.sql` files and it
builds a schema out of them, so navigation and inspections work with no database running — that is
the idea this comes from, in Zed, with a rule set written specifically for MySQL. The
[longer version](https://github.com/sdvallejo/sqldex#where-the-idea-comes-from) is in the project's
own README.

## What you get, and how to reach it

Zed maps all of it to keys it already has:

| | |
|---|---|
| **The column under the cursor**, in full — its type, whether it is nullable, whether it is a primary or unique key, and the table its foreign key points at. Plus its `DEFAULT`, its `COMMENT`, and the values it is allowed to hold: the set the comment documents, or, where nobody wrote one down, the codes the procedures are seen comparing it against | `ctrl-k ctrl-i`, or the mouse |
| **The table under the cursor** — its `CREATE TABLE`, exactly as the repository has it | `ctrl-k ctrl-i` |
| **What a two-letter alias stands for**, and what a temporary table holds and which file created it | `ctrl-k ctrl-i` |
| **Findings as you type** — 45 rules over names, schema, queries and routines: a column that does not exist, an `INSERT` whose value count does not match, an `UPDATE` with no filter, a variable never read, a foreign key with no index | the squiggles and the diagnostics panel; `f8` walks them |
| **Where a name is defined** | `f12` |
| **Where its foreign key leads** | `ctrl-f12`, which is Zed's go-to-type-definition |
| **Everywhere a table or column is used** — whole identifiers, so searching `orders` does not also hand you `aud_orders` | `alt-shift-f12` |
| **Rename it across the project**, definition and uses together | `f2` |
| **Statements written from the catalog** — expand a `*` into the columns it stands for, generate a `SELECT`, an `INSERT` or an `UPDATE` over the table under the cursor, add the columns an audit twin is missing, or rewrite a table's audit triggers | `ctrl-.` |
| **Outline, and every name in the project** | `ctrl-shift-o`, and `ctrl-t` |
| **What a routine calls, and who calls it** | `ctrl-k ctrl-h`, which toggles direction when pressed again |
| **Completion that knows the schema** — the columns of the alias you just typed a dot after, the tables in the project, a routine's parameters | as you type; `ctrl-space` opens the list |
| **A routine's parameters while you fill them in** | `ctrl-i` |
| **Column types, what an alias stands for, and a `CALL`'s parameter names, inline** | inlay hints; `ctrl-:` toggles them |

Everything above comes from the `sqldex-lsp` language server; this extension is the client that
starts it and implements no feature of its own. What is here is how to start the server and for
which files — what gets reported is never decided here, it lives in the project's own
`.sqldex.json`, the same file `sqldex check` reads in CI.

## What you need

- **The [`sql` extension](https://zed.dev/extensions?filter=languages&query=sql)** installed
  alongside this one. Zed ships no SQL grammar of its own — `.sql` files are only recognized as the
  `SQL` language, and get syntax highlighting, once that extension registers it. This extension
  attaches a language server to that language; it does not define one.
- **Node 22.18 or newer** on your `PATH`, unless you install `sqldex-lsp` yourself (see below) —
  that is what the server runs on, and what this extension uses to fetch and run it if nothing else
  is found.

## Installing

Not yet published to Zed's extension registry — see the note at the bottom. Until then, install it
as a **dev extension**: Command Palette → `zed: install dev extension` → pick this directory
(`editors/zed`, not the repository root).

**Nothing else has to be configured.** The first time the server starts for a `.sql` file, this
extension looks for `sqldex-lsp` on your `PATH`; if there isn't one, it fetches `@sqldex/lsp` from
npm and runs it with Node. That check runs again every time the language server (re)starts, so a
new sqldex rule reaches you the next time you open the project — no `npm update` needed. The
exception is a `sqldex-lsp` you installed yourself: it wins over the fetched copy, same as in the
VS Code and Neovim clients, and then `npm update -g @sqldex/lsp` is what brings the rule.

### Settings

One, in your `settings.json`, under `lsp`:

```json
{
  "lsp": {
    "sqldex-lsp": {
      "binary": {
        "path": "/path/to/sqldex-lsp",
        "arguments": ["--stdio"]
      }
    }
  }
}
```

Only needed to point at a server this extension wouldn't otherwise find — a build outside `PATH`, or
one under a name `which` won't resolve. **There is deliberately no setting for what gets reported.**
Severities, which rules run and which directories are sources all live in the project's own
`.sqldex.json`, the same file `sqldex check` reads in CI.

## What's different from the VS Code and Neovim clients

Those two only start a server inside a directory they recognize as a schema project — one holding
`.sqldex.json`, `tablas/`, `sp/`, or `tables/` beside `sps/` or `functions/`. Zed's extension API has
no equivalent hook to gate on before starting a language server, so this extension starts one for
any worktree with an active `.sql` document, project or not. `sqldex-lsp` itself is what has to
degrade quietly there — building an empty catalog and reporting nothing rather than erroring — and
that is worth checking if diagnostics show up somewhere unexpected.

## Not yet on Zed's extension registry

This extension has not been submitted to `zed-industries/extensions` yet, so it does not show up in
Zed's Extensions panel. Installing it as a dev extension, as above, works indefinitely — the only
difference is that nobody else finds it without this repository.
