# sqldex for Neovim

A client for the `sqldex-lsp` language server. It is configuration, not code: the server does the
work, and this says how to start it, for which buffers, and which directory is the project.

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

## What you get, and how to reach it

Neovim maps most of it out of the box:

| | |
|---|---|
| Findings as you type | the diagnostics you already have — `]d`, `[d`, `:lua vim.diagnostic.open_float()` |
| What is this | `K` |
| Where is it defined | `grt` for the column's own line, `gri` for what its foreign key points at |
| Who uses it | `grr` |
| Rename it everywhere | `grn` |
| Rewrite this for me | `gra` — expand a `*`, generate a statement, bring an audit twin up to date |
| Outline, and the project's symbols | `gO`, and `:lua vim.lsp.buf.workspace_symbol()` |
| What a routine calls, and who calls it | `:lua vim.lsp.buf.incoming_calls()` |

Two are off by default in Neovim and worth turning on for this server:

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
