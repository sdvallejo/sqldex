# sqldex for VS Code

A client for the `sqldex-lsp` language server. It implements no feature: the server does the work
and decides everything about a project from that project's own `.sqldex.json`. What is here is the
three questions a client has to answer — how to start the server, for which documents, and which
directory is the project — plus one that only a multi-root editor has to ask.

## What you need

- **VS Code 1.91 or newer**, which is what the language client library needs.
- **Node 22.18 or newer** on your `PATH`, which is what the server runs on.
- The server itself, as `sqldex-lsp` on your `PATH`. Inside a checkout of this repository with its
  dependencies installed, the client finds the server without one being installed.

## Installing

There is no marketplace listing. From a checkout:

```sh
cd editors/vscode && npm install          # the language client library, and only that
ln -s "$PWD" ~/.vscode/extensions/sqldex  # or copy it, if you would rather not link
```

Then reload the window. To work on the client itself instead, open this directory in VS Code and
press <kbd>F5</kbd>, or:

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode" ~/src/your-schema-repo
```

Nothing has to be configured. The extension wakes when a `.sql` file is opened or a `.sqldex.json`
is in the tree, and starts a server only for folders that are schema projects.

## What you get, and how to reach it

VS Code maps all of it to what you already press:

| | |
|---|---|
| Findings as you type | the Problems panel, and the squiggles — <kbd>F8</kbd> walks them |
| What is this | hover |
| Where is it defined | <kbd>F12</kbd>, and <kbd>Ctrl</kbd>+<kbd>F12</kbd> for what a foreign key points at |
| Who uses it | <kbd>Shift</kbd>+<kbd>F12</kbd> |
| Rename it everywhere | <kbd>F2</kbd> |
| Rewrite this for me | <kbd>Ctrl</kbd>+<kbd>.</kbd> — expand a `*`, generate a statement, bring an audit twin up to date |
| Outline, and the project's symbols | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>, and <kbd>Ctrl</kbd>+<kbd>T</kbd> |
| What a routine calls, and who calls it | right-click → Peek → Call Hierarchy |
| Column types and what an alias stands for | inlay hints, on unless you turned them off globally |

Editing `.sqldex.json` gets completion and validation of its own, from a schema this extension
contributes: the keys, the five rule groups, the severities, and the shape of a rule id. Rule **ids**
are deliberately not enumerated in it — a list of them here would be one more copy to keep in step
with the engine, and a stale one would flag a rule that exists. `sqldex rules` prints the current
list, and `sqldex explain <id>` prints one rule's whole reasoning.

## Settings

Two, and neither is about analysis:

| | |
|---|---|
| `sqldex.server.path` | the command to start, when it is not `sqldex-lsp` from your `PATH` |
| `sqldex.trace.server` | log the protocol traffic into the **sqldex** output channel |

**There is deliberately no setting for what gets reported.** Severities, which rules run and which
directories are sources all live in the project's `.sqldex.json`, which is the same file
`sqldex check` reads in CI — because a rule that is off in one place and on in the other is a rule
nobody trusts. A user setting here would be exactly that disagreement, one machine at a time.

## One server per project, not per window

The server is single-root by design: it reads one folder and builds one catalog, because answering
across two projects from one catalog would mean a name in one resolving against a table in the
other. So a window with three schema repositories in it gets three servers, each with its own root.

Two folders that turn out to be inside the *same* repository share one server — otherwise every
finding would arrive twice — and a folder opened below the root still gets the whole project's
answers, because the root is found by walking up from the folder, exactly as the engine does.

A folder that is not a schema project gets no process at all, and the output channel says which one
and why. That guard is the reason the extension can activate on any `.sql` file without indexing a
repository that merely happens to contain one.

## Why it watches files

The server asks the client to watch `**/*.sql` and the config file, and this client obliges without
being asked twice — VS Code creates the watchers from the server's own registration.

It matters more than it sounds. The catalog is built from what is on disk, and updated one file at a
time when you save. A branch switch rewrites hundreds of `.sql` files without one of them passing
through an editor, and every answer afterwards would come from a schema that is no longer there.

If your repository is large and you have narrowed `files.watcherExclude`, note that it applies here
too: a directory VS Code does not watch is one the server is never told about.

## When nothing happens

The **sqldex** output channel, first. It has both sides in it: this client's line about what it
started and why, and the server's own line about which project it built and how much is in it — or
why it built nothing, which is the answer worth reading when the extension started something and the
answers still come back empty.

If the client says the folder is not a schema project, that is the guard above. A project is a
directory holding `.sqldex.json`, `tablas/`, `sp/`, or `tables/` beside `sps/` or `functions/`. An
empty `.sqldex.json` at the root is enough to declare one.

If nothing was started at all, the extension never woke: it activates on a `.sql` file being opened
or a `.sqldex.json` in the tree, and a window with neither gives it no reason to.

**sqldex: Restart the language server** in the command palette picks up a project that came into
existence after the window was opened — a `.sqldex.json` you just wrote, a `tables/` you just made.
