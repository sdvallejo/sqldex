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

--- Directories that declare a schema project, in the same terms the engine uses.
---
--- `tablas/` and `sp/` are enough on their own: nothing else is called that. `tables/`, on the other
--- hand, is a plausible directory in a repo that has nothing to do with a database, so the English
--- layout is only recognised when a routines directory is there too.
---
--- The engine applies the same test on its side and will refuse to build a catalog for a directory
--- that fails it, so a disagreement here costs a line in the log rather than a wrong answer. The
--- reason to have it anyway is that this one runs *first*: a repo that merely happens to contain a
--- `.sql` file never starts a server at all.
local DECLARES = {
  { ".sqldex.json" },
  { "tablas" },
  { "sp" },
  { "tables", "sps" },
  { "tables", "functions" },
}

--- Does this directory hold every one of these markers?
local function holds(dir, markers)
  for _, marker in ipairs(markers) do
    if not vim.uv.fs_stat(vim.fs.joinpath(dir, marker)) then return false end
  end
  return true
end

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
local function command()
  if vim.fn.executable("sqldex-lsp") == 1 then return { "sqldex-lsp", "--stdio" } end

  local root = checkout()
  local main = vim.fs.joinpath(root, "packages", "lsp", "src", "main.ts")
  if vim.uv.fs_stat(main) and vim.uv.fs_stat(vim.fs.joinpath(root, "node_modules", "vscode-languageserver")) then
    return { "node", main, "--stdio" }
  end

  return { "sqldex-lsp", "--stdio" }
end

return {
  cmd = command(),
  filetypes = { "sql", "mysql" },

  --- Each declaration is tried all the way up the tree before the next one, so a distant
  --- `.sqldex.json` beats a nearby `tablas/`: if somebody took the trouble to write one, that is the
  --- root they meant.
  ---
  --- Not calling `on_dir` is how a client says "not here". It is deliberate and it is the whole
  --- reason this is a function rather than a list of markers, which can only express *any of* and
  --- not *all of*.
  root_dir = function(bufnr, on_dir)
    local file = vim.api.nvim_buf_get_name(bufnr)
    if file == "" then return end

    for _, markers in ipairs(DECLARES) do
      for dir in vim.fs.parents(file) do
        if holds(dir, markers) then return on_dir(dir) end
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
