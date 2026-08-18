--- `:checkhealth sqldex`.
---
--- Everything here is something that fails *quietly*: a server that is not on the `PATH`, a Node too
--- old to run it, a project the client does not recognise, and one platform where file watching
--- degrades without saying so. None of them produce an error you would notice while writing SQL —
--- you would just find the answers thin and have nowhere to look.

local M = {}

--- The oldest Node that runs the server. Below this, a `.ts` file is a syntax error rather than a
--- program, and the failure a person sees is a stack trace from the runtime.
local NODE_MINIMUM = { 22, 18 }

--- `v22.18.0` → `{ 22, 18 }`.
local function node_version()
  local out = vim.system({ "node", "--version" }, { text = true }):wait()
  if out.code ~= 0 then return nil end
  local major, minor = out.stdout:match "v(%d+)%.(%d+)"
  if not major then return nil end
  return { tonumber(major), tonumber(minor) }, vim.trim(out.stdout)
end

local function nvim()
  vim.health.start "Neovim"
  local v = vim.version()
  if vim.fn.has "nvim-0.11" == 1 then
    vim.health.ok(("%d.%d.%d, which has vim.lsp.enable()"):format(v.major, v.minor, v.patch))
  else
    vim.health.error("needs 0.11 or newer for vim.lsp.enable()", { "update Neovim" })
  end
end

local function server()
  vim.health.start "The server"

  local config = vim.lsp.config.sqldex
  local cmd = config and config.cmd
  if type(cmd) ~= "table" then
    vim.health.error("no command is configured", { "is editors/nvim on the runtimepath?" })
    return
  end
  vim.health.info("cmd: " .. table.concat(cmd, " "))

  if cmd[1] == "sqldex-lsp" then
    if vim.fn.executable "sqldex-lsp" == 1 then
      vim.health.ok "sqldex-lsp is on the PATH"
    else
      vim.health.error("sqldex-lsp is not on the PATH, and no checkout was found to run instead", {
        "install the server, or point cmd at one: vim.lsp.config('sqldex', { cmd = { '/path/to/sqldex-lsp', '--stdio' } })",
      })
    end
    return
  end

  -- Running a checkout directly, which is the other supported way and needs a Node new enough to
  -- read TypeScript on its own.
  vim.health.ok "running from a checkout"
  local version, printed = node_version()
  if not version then
    vim.health.error "node is not on the PATH"
  elseif version[1] > NODE_MINIMUM[1] or (version[1] == NODE_MINIMUM[1] and version[2] >= NODE_MINIMUM[2]) then
    vim.health.ok(("node %s"):format(printed))
  else
    vim.health.error(
      ("node %s is too old to run the server from source"):format(printed),
      { ("%d.%d or newer"):format(NODE_MINIMUM[1], NODE_MINIMUM[2]) }
    )
  end
end

--- Whether this platform can actually watch the files the server asks it to.
---
--- The client says it can watch, and on macOS and Windows it can. On Linux, Neovim watches with
--- `inotifywait` when it is installed and otherwise falls back to walking the directories itself —
--- and that fallback tests each **directory** against the server's glob before watching it. The
--- glob is `**/*.sql`, which no directory matches, so nothing below the project root ends up
--- watched: a table rewritten by a branch switch in `tables/` goes unnoticed until it is saved from
--- a buffer.
---
--- Nothing here is wrong, and there is nothing to fix in the client: it is one package away.
local function watching()
  vim.health.start "File watching"

  if vim.fn.has "linux" == 0 then
    vim.health.ok "this platform watches recursively on its own"
    return
  end

  if vim.fn.executable "inotifywait" == 1 then
    vim.health.ok "inotifywait is installed, so the whole project is watched"
  else
    vim.health.warn("inotifywait is not installed, so only the project's top directory is watched", {
      "install inotify-tools",
      "without it, a file changed outside the editor — a branch switch, a rebase — is only picked up when something under it is saved",
    })
  end
end

--- Is anything attached, and to what?
---
--- The root is what a wrong answer usually comes down to: the server was started somewhere that is
--- not the project, and every name resolves against a catalog built from the wrong tree.
local function attached()
  vim.health.start "This session"

  local clients = vim.lsp.get_clients { name = "sqldex" }
  if #clients == 0 then
    vim.health.info "no server is running; open a file in a schema project"
    return
  end
  for _, client in ipairs(clients) do
    vim.health.ok(("attached, with %s as the project root"):format(client.root_dir or "no root"))
  end
end

function M.check()
  nvim()
  server()
  watching()
  attached()
end

return M
