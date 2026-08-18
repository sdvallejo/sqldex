# sqldex for Neovim

*Gotta index 'em all!*

A repository full of `CREATE TABLE` and `CREATE PROCEDURE` files **is** a database schema, and this
makes Neovim read it as one. Open a stored procedure and every table in the project is already
known — its columns, their types, which ones are nullable, where each foreign key leads, and the
values a one-letter status column is allowed to hold. No database connection, no credentials,
nothing running: the catalog is built from the `.sql` files themselves.

What that buys you is the answer to the questions a schema repository raises all day. *What is
`c.doc_type` and what can it hold. Which table is `d` again. Who else writes to this table. What
would this rename touch.* All of it is a keypress, and none of it is a text search.

If you have used **DataGrip's DDL data source** — point the IDE at a directory of `.sql` files and it
builds a schema out of them, so navigation and inspections work with no database running — that is
the idea this comes from, in Neovim, with a rule set written specifically for MySQL. The
[longer version](../../README.md#where-the-idea-comes-from) is in the project's own README.

## What you get, and how to reach it

Neovim maps most of it to keys you already have:

| | |
|---|---|
| **The column under the cursor**, in full — its type, whether it is nullable, whether it is a primary or unique key, and the table its foreign key points at. Plus its `DEFAULT`, its `COMMENT`, and the values it is allowed to hold: the set the comment documents, or, where nobody wrote one down, the codes the procedures are seen comparing it against | `K` |
| **The table under the cursor** — its `CREATE TABLE`, exactly as the repository has it | `K` |
| **What a two-letter alias stands for**, and what a temporary table holds and which file created it | `K` |
| **Findings as you type** — 38 rules over names, schema, queries and routines: a column that does not exist, an `INSERT` whose value count does not match, an `UPDATE` with no filter, a variable never read, a foreign key with no index | `]d`, `[d`, `:lua vim.diagnostic.open_float()` |
| **Where a name is defined**, and where its foreign key leads | `grt` for the definition, `gri` for the foreign key's target |
| **Everywhere a table or column is used** — whole identifiers, so searching `orders` does not also hand you `aud_orders` | `grr` |
| **Rename it across the project**, definition and uses together | `grn` |
| **Statements written from the catalog** — expand a `*` into the columns it stands for, generate a `SELECT`, an `INSERT` or an `UPDATE` over the table under the cursor, add the columns an audit twin is missing, or rewrite a table's audit triggers | `gra` |
| **Outline, and every name in the project** | `gO`, and `:lua vim.lsp.buf.workspace_symbol()` |
| **What a routine calls, and who calls it** | `:lua vim.lsp.buf.incoming_calls()` |
| **Completion that knows the schema** — the columns of the alias you just typed a dot after, the tables in the project, a routine's parameters | see below |
| **Types and aliases inline**, without hovering | see below |

Two of these are off by default in Neovim and worth turning on for this server:

```lua
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(event)
    local client = vim.lsp.get_client_by_id(event.data.client_id)
    if not client or client.name ~= "sqldex" then return end

    -- The column type on a qualified reference, and what a two-letter alias stands for.
    vim.lsp.inlay_hint.enable(true, { bufnr = event.buf })
    -- Completion without a plugin. Trigger characters included, so `o.` opens the list.
    vim.lsp.completion.enable(true, client.id, event.buf, { autotrigger = true })
  end,
})
```

Everything above comes from the `sqldex-lsp` language server; this directory is the client that
starts it. It is configuration, not code: the server does the work, and this says how to start it,
for which buffers, and which directory is the project. What gets reported is never decided here —
it lives in the project's own `.sqldex.json`, the same file `sqldex check` reads in CI.

## What you need

- **Neovim 0.11 or newer**, for `vim.lsp.enable()`.
- **Node 22.18 or newer**, which is what the server runs on.
- The server itself, as `sqldex-lsp` on your `PATH`. Inside a checkout of this repository with its
  dependencies installed, the client finds the server without one being installed.

## Installing

The client is this directory, not the repository root, so whatever puts it on the runtimepath has to
point at the directory:

```lua
-- lazy.nvim, from a checkout
{ dir = vim.fn.expand "~/src/sqldex/editors/nvim" }

-- or by hand, anywhere in your config
vim.opt.runtimepath:append(vim.fn.expand "~/src/sqldex/editors/nvim")
```

There is nothing to call afterwards. A `plugin/` file enables the server, and enabling costs an
autocommand: it starts when a buffer is SQL *and* sits in a schema project, and never otherwise.

If you would rather not install anything, the whole client is four lines in your own config:

```lua
vim.lsp.config("sqldex", {
  cmd = { "sqldex-lsp", "--stdio" },
  filetypes = { "sql" },
  root_markers = { ".sqldex.json", "tablas", "sp" },
})
vim.lsp.enable "sqldex"
```

What you give up by doing that is the part of `lsp/sqldex.lua` that is a decision rather than a
value: which directories declare a project, and the file watching described below.

## Why it asks to watch files

The client declares `didChangeWatchedFiles`, which Neovim leaves off by default — for most servers
that is the right call, since watching a large tree is not free.

Here it is what keeps the answers true. The server rereads a file when you save it, which covers
everything that goes through a buffer, and nothing else does: a branch switch rewrites hundreds of
`.sql` files without one being opened, and every answer afterwards would come from a schema that is
no longer on disk. What gets watched is narrow — `**/*.sql` and the config file, not the tree.

**On Linux, install `inotify-tools`.** Neovim watches with `inotifywait` when it is there, and
otherwise falls back to walking the directories itself — a fallback that tests each *directory*
against the server's glob before watching it. The glob is `**/*.sql`, which no directory matches, so
nothing below the project root gets watched and a table rewritten in `tables/` goes unnoticed. It is
a warning in `:checkhealth sqldex`, because it is the one thing here that degrades without saying so.

To turn watching off entirely:

```lua
vim.lsp.config("sqldex", {
  capabilities = { workspace = { didChangeWatchedFiles = { dynamicRegistration = false } } },
})
```

The server then says so in its log rather than pretending, and a save is the only thing that updates
the catalog.

## When nothing happens

`:checkhealth sqldex` first: it covers the four things that fail without an error — no server on the
`PATH`, a Node too old to run one from a checkout, a project the client did not recognise, and the
watching above.

`:checkhealth vim.lsp` shows whether a client attached and what it declared. If none did, the buffer
is not in a directory the client recognises as a schema project: one holding `.sqldex.json`,
`tablas/`, `sp/`, or `tables/` beside `sps/` or `functions/`. An empty `.sqldex.json` at the root is
enough to declare one.

`:LspLog` has the server's own side. It says on startup which project it built and how much is in it
— or why it built nothing, which is the same test applied a second time and is the answer worth
reading when a client attached and the answers still come back empty.
