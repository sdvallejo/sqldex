# sqldex for VS Code

*Gotta index 'em all!*

A repository full of `CREATE TABLE` and `CREATE PROCEDURE` files **is** a database schema, and this
makes VS Code read it as one. Open a stored procedure and every table in the project is already
known — its columns, their types, which ones are nullable, where each foreign key leads, and the
values a one-letter status column is allowed to hold. No database connection, no credentials,
nothing running: the catalog is built from the `.sql` files themselves.

What that buys you is the answer to the questions a schema repository raises all day. *What is
`c.doc_type` and what can it hold. Which table is `d` again. Who else writes to this table. What
would this rename touch.* All of it is a keypress, and none of it is a text search.

If you have used **DataGrip's DDL data source** — point the IDE at a directory of `.sql` files and it
builds a schema out of them, so navigation and inspections work with no database running — that is
the idea this comes from, in VS Code, with a rule set written specifically for MySQL. The
[longer version](https://github.com/sdvallejo/sqldex#where-the-idea-comes-from) is in the project's own README.

## What you get, and how to reach it

VS Code maps all of it to what you already press:

| | |
|---|---|
| **The column under the cursor**, in full — its type, whether it is nullable, whether it is a primary or unique key, and the table its foreign key points at. Plus its `DEFAULT`, its `COMMENT`, and the values it is allowed to hold: the set the comment documents, or, where nobody wrote one down, the codes the procedures are seen comparing it against | hover |
| **The table under the cursor** — its `CREATE TABLE`, exactly as the repository has it | hover |
| **What a two-letter alias stands for**, and what a temporary table holds and which file created it | hover |
| **Findings as you type** — 45 rules over names, schema, queries and routines: a column that does not exist, an `INSERT` whose value count does not match, an `UPDATE` with no filter, a variable never read, a foreign key with no index | the Problems panel and the squiggles; <kbd>F8</kbd> walks them |
| **Where a name is defined**, and where its foreign key leads | <kbd>F12</kbd>, and <kbd>Ctrl</kbd>+<kbd>F12</kbd> for the foreign key's target |
| **Everywhere a table or column is used** — whole identifiers, so searching `orders` does not also hand you `aud_orders` | <kbd>Shift</kbd>+<kbd>F12</kbd> |
| **Rename it across the project**, definition and uses together | <kbd>F2</kbd> — this extension's own rename, see below |
| **Statements written from the catalog** — expand a `*` into the columns it stands for, generate a `SELECT`, an `INSERT` or an `UPDATE` over the table under the cursor, add the columns an audit twin is missing, or rewrite a table's audit triggers | <kbd>Ctrl</kbd>+<kbd>.</kbd> |
| **Outline, and every name in the project** | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd>, and <kbd>Ctrl</kbd>+<kbd>T</kbd> |
| **What a routine calls, and who calls it** | right-click → Peek → Call Hierarchy |
| **Completion that knows the schema** — the columns of the alias you just typed a dot after, the tables in the project, a routine's parameters | as you type; `o.` opens the list |
| **Column types, what an alias stands for, and a `CALL`'s parameter names, inline** | inlay hints, on unless you turned them off globally |

Editing `.sqldex.json` gets completion and validation of its own, from a schema this extension
contributes: the keys, the five rule groups, the severities, and the shape of a rule id. Rule **ids**
are deliberately not enumerated in it — a list of them here would be one more copy to keep in step
with the engine, and a stale one would flag a rule that exists. `sqldex rules` prints the current
list, and `sqldex explain <id>` prints one rule's whole reasoning.

Everything above comes from the `sqldex-lsp` language server; this extension is the client that
starts it, and it implements no feature of its own. What is here is the three questions a client has
to answer — how to start the server, for which documents, and which directory is the project — plus
one that only a multi-root editor has to ask. What gets reported is never decided here: it lives in
the project's own `.sqldex.json`, the same file `sqldex check` reads in CI.

## What you need

- **VS Code 1.91 or newer**, which is what the language client library needs.
- **Node 22.18 or newer** on your `PATH`, which is what the server runs on.
- The server, which an installed `.vsix` already contains. A checkout finds its own, and a
  `sqldex-lsp` you installed yourself wins over both.

## Installing

From the Extensions view — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd>, search **sqldex** — or

```sh
code --install-extension sqldex.sqldex
```

**It carries the server with it**, which is what makes it worth installing on a machine that has
never seen this repository — see below. What it does not carry is Node: the machine installing it
needs **Node 22.18 or newer** on its `PATH`, and the extension says so in a notification rather than
failing quietly if it finds an older one. On Windows, the installer at
[nodejs.org](https://nodejs.org) or `winget upgrade OpenJS.NodeJS.LTS` replaces an older install in
place.

That is also what decides how a **new rule** reaches you. The engine is inside the extension, so a
version of the engine is a version of the extension: rules arrive when VS Code updates it, which it
does on its own. The exception is a `sqldex-lsp` you installed yourself — it wins over the bundled
copy, and then `npm update -g @sqldex/lsp` is what brings the rule and the extension has nothing to
do with it.

### Without the marketplace

A `.vsix` is a file, and building one from a checkout is two commands:

```sh
cd editors/vscode
npm install
npm run package      # downloads vsce on demand; leaves sqldex-<version>.vsix beside this file
```

That file is the thing to hand to somebody else — an air-gapped machine, a fork, a version that was
never released. They install it with `code --install-extension sqldex-<version>.vsix`, or through the
Extensions view: the `…` menu, **Install from VSIX**.

To work on the client itself, skip all of that: open this directory in VS Code and press
<kbd>F5</kbd>, or

```sh
code --extensionDevelopmentPath="$PWD/editors/vscode" ~/src/your-schema-repo
```

Nothing has to be configured either way. The extension wakes when a `.sql` file is opened or a
`.sqldex.json` is in the tree, and starts a server only for folders that are schema projects.

## Rename, and why it has a command of its own

<kbd>F2</kbd> here runs **sqldex: Rename symbol** rather than the editor's built-in rename, and that
is deliberate.

VS Code picks *one* provider for a rename. For the prepare step it walks the registered providers and
**stops at the first one that does not implement it**, falling back to the plain word under the
cursor; for the edit it takes the first provider that answers with anything at all, an empty answer
included. Which provider comes first is decided by which one registered last, so with two SQL
language servers in the same window it is a race — and the other ones commonly declare
`renameProvider: true` without the prepare half, take the request, and answer with nothing.

The result is a rename that opens its input box, accepts a name, and changes nothing, with no error
anywhere. If you have `sqls`, SQLTools or another SQL server installed, that is what you would get
about half the time.

The command does not enter the race: it asks the server this extension started and applies what comes
back. To give <kbd>F2</kbd> back to the editor, unbind it in your own keybindings:

```json
{ "key": "f2", "command": "-sqldex.rename" }
```

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

## What is in the package, and why it is source

The `.vsix` contains the client, its language client library, and **the server itself** — the
`packages/core` and `packages/lsp` sources, copied into `server/`. An extension that only knew how
to find a server somebody else installed would be an extension that does nothing when installed,
and nothing is published to npm for that somebody to install from.

Source, not a build: the server is TypeScript that Node runs by stripping the types, which is why
this repository has no build step and why what ships is what is in `packages/`. `npm run package`
copies it and rewrites exactly one thing — the `@sqldex/core` import, which a `node_modules` would
have answered and here has to be a relative path.

That is the reason `server/` is not laid out as a `node_modules`, and it is worth knowing before
"tidying" it: **Node refuses to strip types from a file under `node_modules`**, so an extension
packaged that way installs perfectly and then dies at the first import with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.

Where the server comes from, in the order the extension tries:

| | |
|---|---|
| `sqldex.server.path` | somebody named a file |
| `sqldex-lsp` on the `PATH` | somebody installed one |
| the checkout above this directory | somebody cloned the repository — and beats the bundle, since the bundle is a copy taken from it |
| `server/` inside the extension | what an installed `.vsix` runs |

The **sqldex** output channel says which of the four it used, every time it starts one.

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
started and why, the server's own line about which project it built and how much is in it — or why
it built nothing, which is the answer worth reading when the extension started something and the
answers still come back empty — and, if the server could not be started at all, the error, which
also arrives as a notification.

If the client says the folder is not a schema project, that is the guard above. A project is a
directory holding `.sqldex.json`, `tablas/`, `sp/`, or `tables/` beside `sps/` or `functions/`. An
empty `.sqldex.json` at the root is enough to declare one.

If nothing was started at all, the extension never woke: it activates on a `.sql` file being opened
or a `.sqldex.json` in the tree, and a window with neither gives it no reason to.

**A `.sql` file can end up in another extension's language mode**, not the editor's built-in `sql` —
MySQL Shell for VS Code is one that ships its own, and VS Code hands `.sql` to whichever installed
extension's id sorts first alphabetically when two disagree. Nothing here depends on winning that
tie-break: the client selects documents by file extension, not by language id, precisely because that
tie-break is not this extension's to win. The status bar may still say something other than **SQL** —
that is cosmetic only.

**sqldex: Restart the language server** in the command palette picks up a project that came into
existence after the window was opened — a `.sqldex.json` you just wrote, a `tables/` you just made.

It is also the answer to a rule that fires everywhere except here. **Installing a new version of the
extension does not restart the server the window is already running**, so a window left open across
an upgrade keeps the old engine until it is told otherwise. The startup line in the output channel
ends with a rule count for exactly this: if it disagrees with `sqldex rules`, the process is older
than the files it came from.
