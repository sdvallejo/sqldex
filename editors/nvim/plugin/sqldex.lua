--- Turns the server on.
---
--- Two lines of work and one decision: a plugin that has to be configured before it does anything is
--- a plugin that gets installed and then forgotten. Enabling costs an autocommand — the server is
--- started when a buffer both matches the filetypes and resolves to a project root, and never
--- otherwise — so there is nothing to be gained by making somebody ask for it.
---
---     vim.g.sqldex_enable = false   -- before this file loads, to enable it yourself
if vim.g.sqldex_enable == false then return end

--- `vim.lsp.config` and `vim.lsp.enable` are 0.11. Older versions can still run the server through
--- whatever they configure by hand, so this says what is missing and gets out of the way rather than
--- failing on a call that does not exist.
if vim.fn.has "nvim-0.11" == 0 then
  vim.notify("sqldex: needs Neovim 0.11 or newer for vim.lsp.enable()", vim.log.levels.WARN)
  return
end

vim.lsp.enable "sqldex"
