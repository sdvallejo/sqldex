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
- **The server**, which is one command:

  ```sh
  npm install -g @sqldex/lsp
  ```

  That puts `sqldex-lsp` on your `PATH`, which is the only thing the client looks for. The other
  published command, `npm install -g sqldex`, is the CLI that runs these same rules over the same
  project in CI — a different job, and not what Neovim needs.

The client prefers an installed `sqldex-lsp` over anything else, and falls back to running the
server out of the checkout it sits in — which a plugin manager's clone can become, if you would
rather install nothing globally. That is [below](#without-installing-the-server-globally).

## Installing

The client is `editors/nvim/` **inside** the repository, not the repository root, so whatever puts
it on the runtimepath has to point at that directory. Every recipe below is that one sentence in a
different dialect, and none of them asks you to clone anything yourself.

### Neovim 0.12, with no plugin manager at all

```lua
vim.pack.add { { src = "https://github.com/sdvallejo/sqldex" } }
vim.opt.rtp:append(vim.fn.stdpath "data" .. "/site/pack/core/opt/sqldex/editors/nvim")
vim.cmd.runtime "plugin/sqldex.lua"
```

`vim.pack` puts the repository root on the runtimepath, where there is nothing Neovim wants; the
second line adds the part where there is, and the third sources the file that a manager pointed at
the right directory would have sourced by itself.

### lazy.nvim

lazy.nvim has no spec field for a subdirectory of a repository, so the same two lines go in
`config`, where the clone's own path arrives as a parameter:

```lua
{
  "sdvallejo/sqldex",
  lazy = false,
  config = function(plugin)
    vim.opt.rtp:append(plugin.dir .. "/editors/nvim")
    vim.cmd.runtime "plugin/sqldex.lua"
  end,
}
```

**`lazy = false` is deliberate, and it costs an autocommand** — that is the whole of what loading
this does. `ft = { "sql", "mysql" }` works and starts the server just the same, but until the first
SQL buffer exists nothing is loaded, and `:checkhealth sqldex` answers *No healthcheck found* — the
command you reach for precisely when no SQL buffer is doing anything.

For working on the client itself, a checkout still goes in directly, and this is the one form that
needs no `rtp` line, because it names the directory:

```lua
{ dir = vim.fn.expand "~/src/sqldex/editors/nvim" }
```

### vim-plug

The only one here that knows about a subdirectory on its own, which makes it the shortest:

```vim
Plug 'sdvallejo/sqldex', { 'rtp': 'editors/nvim' }
```

### Without installing the server globally

The server is the one part of this that is not Lua, and it does not have to live on your `PATH`. The
client falls back to the checkout it belongs to, and a clone becomes one the moment its dependencies
are there — which is a hook every manager above already has:

```lua
-- lazy.nvim, added to the spec
build = "npm install --omit=dev",
```

```vim
" vim-plug
Plug 'sdvallejo/sqldex', { 'rtp': 'editors/nvim', 'do': 'npm install --omit=dev' }
```

```lua
-- vim.pack has no build field, so the hook is an autocommand. Before vim.pack.add.
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(ev)
    if ev.data.spec.name == "sqldex" and ev.data.kind ~= "delete" then
      vim.system({ "npm", "install", "--omit=dev" }, { cwd = ev.data.path }):wait()
    end
  end,
})
```

`--omit=dev` is the whole point of the line: what the server actually needs is the protocol library,
which is 1.7 MB and a second. Everything else in this repository's `devDependencies` is for building
and testing it, and none of it runs here — there is **no build step**, because the client tells Node
to resolve this project to its own sources.

What you give up is what an installed package gives you: it is built JavaScript, self-contained, and
does not re-run `npm` every time the plugin updates. That is why `npm install -g @sqldex/lsp` is
still the shorter answer, and this one is for people who would rather their editor own everything it
uses.

### By hand, from a checkout

```lua
vim.opt.runtimepath:append(vim.fn.expand "~/src/sqldex/editors/nvim")
```

Nothing follows this one: Neovim sources `plugin/` files from the runtimepath after your config, so
the append is enough.

Whichever one you use, that is all the wiring there is. The `plugin/` file those recipes reach for
does exactly one thing — it enables the server — and enabling costs an autocommand: it starts when a
buffer is SQL *and* sits in a schema project, and never otherwise. Nothing else has to be called,
and there is no `setup()`.

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
