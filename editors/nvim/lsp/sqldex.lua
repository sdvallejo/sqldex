--- The `sqldex` language server, described the way Neovim's LSP client wants it.
---
--- Nothing here implements a feature. The server speaks the protocol over stdio and decides
--- everything about a project from that project's own `.sqldex.json`, so a client has three jobs and
--- no more: say how to start it, say for which buffers, and say which directory is the project.
---
--- The file is picked up by `vim.lsp.enable("sqldex")` because of where it sits — `lsp/<name>.lua`
--- anywhere on the runtimepath. Anything in it can be overridden without touching it:
---
---     vim.lsp.config("sqldex", { cmd = { "/path/to/sqldex-lsp", "--stdio" } })

--- Names that mark the root of a schema project.
---
--- The engine decides whether a directory really is one — it reads the files, and it refuses to
--- build a catalog for one that is not. This runs *first*, before anything has been started, which
--- is why it cannot do the same reading and has to settle for names.
---
--- The two only stay safe while this one errs towards **yes**. Saying yes where the engine says no
--- costs a server that starts, finds nothing, and writes one line in its log saying so. Saying no
--- where the engine says yes costs a schema project that never produces a diagnostic and never
--- explains why — which is exactly what a list of layout names did to every repo whose routines
--- lived under a name nobody had listed.
---
--- `.git` comes last and is the loosest of them: it is what catches the project the layout names
--- miss. Presence is all that is asked of a marker, not that it be a directory, because `.git` is a
--- *file* in a worktree and in a submodule.
local MARKERS = {
  ".sqldex.json",
  "tablas",
  "sp",
  "tables",
  "sps",
  "functions",
  "procedures",
  "triggers",
  ".git",
}

--- The checkout this file belongs to, so a clone can run the server it ships with.
local function checkout()
  local self = debug.getinfo(1, "S").source:sub(2)
  return vim.fs.normalize(vim.fs.joinpath(vim.fs.dirname(self), "..", "..", ".."))
end

--- How to start the server.
---
--- The installed command wins when there is one: it is self-contained, and somebody who installed it
--- meant to use it. Failing that, a checkout can run its own server directly — but only one whose
--- dependencies are installed, because the protocol library is the one thing the server cannot do
--- without and a clone made by a plugin manager will not have it.
---
--- When neither is there the installed name is returned anyway, so the failure a person sees is the
--- client's own "command not found" rather than something invented here.
---
--- `--conditions=development` is what makes a checkout resolve to its own **sources**. Every package
--- here points its exports at `dist/`, which is what gets published and which a checkout has no
--- reason to build; the `development` condition points at `src/` instead, and it is opt-in because
--- an installed package must never take it. Without the flag the server starts, imports
--- `@sqldex/core`, and dies on a `dist/index.js` that was never built — in a process the editor
--- started, so what a person sees is a client that quit, with the reason only in the log.
local function command()
  if vim.fn.executable("sqldex-lsp") == 1 then return { "sqldex-lsp", "--stdio" } end

  local root = checkout()
  local main = vim.fs.joinpath(root, "packages", "lsp", "src", "main.ts")
  if vim.uv.fs_stat(main) and vim.uv.fs_stat(vim.fs.joinpath(root, "node_modules", "vscode-languageserver")) then
    return { "node", "--conditions=development", main, "--stdio" }
  end

  return { "sqldex-lsp", "--stdio" }
end

return {
  cmd = command(),
  filetypes = { "sql", "mysql" },

  --- Each marker is tried all the way up the tree before the next one, so a distant `.sqldex.json`
  --- beats a nearby `tablas/`: if somebody took the trouble to write one, that is the root they
  --- meant. By the same order a layout name, however far up, beats the nearest `.git`.
  ---
  --- Not calling `on_dir` is how a client says "not here", and it is the whole reason this is a
  --- function: `vim.lsp.config`'s own `root_markers` cannot say *last resort*.
  root_dir = function(bufnr, on_dir)
    local file = vim.api.nvim_buf_get_name(bufnr)
    if file == "" then return end

    for _, marker in ipairs(MARKERS) do
      for dir in vim.fs.parents(file) do
        if vim.uv.fs_stat(vim.fs.joinpath(dir, marker)) then return on_dir(dir) end
      end
    end
  end,

  capabilities = {
    workspace = {
      --- Neovim leaves this off by default, and for most servers that is the right call: watching a
      --- large tree is not free. Here it is what makes the catalog true. The server updates one file
      --- on save, which covers everything that goes through a buffer — and nothing else does: a
      --- branch switch rewrites hundreds of `.sql` files without one being opened, and every answer
      --- afterwards would come from a schema that is no longer there.
      ---
      --- What gets watched is narrow on purpose: the server registers `**/*.sql` and the config
      --- file, not the tree. Turn it off with
      --- `vim.lsp.config("sqldex", { capabilities = { workspace = { didChangeWatchedFiles = { dynamicRegistration = false } } } })`
      --- and the server will say so in its log rather than pretend.
      didChangeWatchedFiles = { dynamicRegistration = true },
    },
  },
}
