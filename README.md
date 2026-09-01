# sqldex

*Gotta index 'em all!*

Static analysis for MySQL schemas that live as `.sql` files in a repository.

A repo full of `CREATE TABLE` and `CREATE PROCEDURE` files *is* a database schema, but no tool
treats it as one. Your editor sees text. MySQL only sees it once you apply it. sqldex reads the
whole repo and builds a catalog — tables, columns, indexes, foreign keys, triggers, routines and
the temporary tables procedures pass around — so that questions about names can be answered
without a server: what columns does this alias have, where is this table defined, who points at
it with a foreign key, which values is this status column allowed to hold.

It is written for schemas dumped out of a live database with `SHOW CREATE`, which are the messy
ones: thousands of files, no migrations, procedures that build temporary tables in one place and
read them in another, names in two languages and three casing styles.

The name is what the tool does — it indexes a schema — read as the obvious pun, since a catalog of
several hundred creatures you did not design and have to look up constantly is a fair description of
somebody else's database.

## Where the idea comes from

From DataGrip's **DDL data source**: point the IDE at a directory of `.sql` files and it builds a
schema out of them, so completion, navigation and inspections work with no database running. That is
exactly the right premise for a repository whose schema *is* its files, and sqldex is that premise
taken on its own — as a command that runs in CI, a library, and a language server any editor can
speak to, with a rule set written specifically for MySQL and a written argument behind each rule.

Nothing else nearby occupies quite the same place. The general SQL linters — `sqlfluff` most of all —
are dialect-aware but schema-blind: they judge style, layout and structural ambiguity, and cannot
know that a `WHERE` touches only part of a unique key, because they never see the key. The tools that
do read a real schema are aimed at migrations rather than at everyday SQL: `skeema lint` validates
MySQL DDL against a server, `atlas migrate lint` classifies a change as destructive or backwards-incompatible,
`squawk` does the same for Postgres. And the SQL language servers that already give completion from a
live connection, such as `sqls` and `sql-language-server`, stop there — the catalog is used for names,
not for claims about the code. What is left over is this: a catalog built from the files, and rules
that use it to say something checkable about the queries and procedures written against them.

## Status

**Early, but usable.** The engine, the rules and the command are complete and tested.

```sh
npm install -g sqldex          # the command
npm install -g @sqldex/lsp     # the language server, for an editor
npm install @sqldex/core       # the catalog and the rule engine, as a library
code --install-extension sqldex.sqldex   # VS Code, server included — nothing else to install
```

| | |
|---|---|
| Catalog and name resolution | works |
| Rule engine | works — registry, traversals, suppression, per-rule severity |
| Lint rules | 46 of them, in five groups — see below |
| `sqldex` CLI | works — `check`, `rules`, `explain`, five output formats |
| `sqldex-lsp` language server | findings as you type, hover, completion, signature help, goto definition and type definition, references, rename, call hierarchy, symbols, inlay hints, code actions |
| Editor clients | one for Neovim and one for VS Code, in `editors/`; the VS Code one is on the Marketplace and carries the server inside the `.vsix`, and `editors/nvim` installs from this repository |
| Dialects other than MySQL | not planned for the first release; the engine-specific decisions are already behind a `Dialect` interface |
| `ALTER TABLE` | not parsed |

## What the engine does

**Finds the project.** Two directory conventions are recognised without configuration —
`tablas/` + `sp/` + `carga-valores/` and `tables/` + `sps/` + `functions/` + `triggers/` — and any
other layout, including everything in one directory, works by sweeping `**/*.sql`. A source's kind
is a work budget and never a filter: a flat sweep finds everything a declared layout finds.

**Builds a catalog** that stores offsets and paths rather than the files' text, so a large repo
costs a few hundred KB and a hover reads its one file on demand. On top of the plain declarations
it derives what needs the whole schema to know: incoming foreign keys, how a column name is typed
across every table that has it, and the values an enum-like `char(1)` column is actually seen
holding — from its `COMMENT` when the author wrote one down, and otherwise from the literals the
procedures compare it against.

**Resolves names** the way an editor needs them: aliases shadowing table names, `NEW`/`OLD` inside
a trigger, common table expressions, derived tables, references into a schema this repo does not
define, and temporary tables — including the columns a `CREATE TEMPORARY TABLE ... SELECT *`
inherits from whatever fed it.

**Reads a routine's body** for what only exists in it: parameters, `DECLARE` variables, cursors,
the columns a `SELECT` list defines, and where each was declared.

**Locates the cursor** and classifies what belongs at it — a qualified column, a table name, a
routine, the columns of an `INSERT INTO t (...)`, the values of a column being compared — which is
what completion and signature help are built from.

**Finds every use of a name**, which is the one question the catalog cannot answer, because it
deliberately never parses routine bodies. Whole identifier tokens, not substrings: searching a table
called `orders` by text also returns `aud_orders` and `LogOrders`, which are different tables. A
column is narrowed to its own table — a use qualified by an alias of it, or a bare one in a
statement that involves it and only when the table really has that column, since otherwise asking
about a column its table does not have answers with every other table's column of the same name.

**Carries MySQL's built-in functions**: signature, a one-line summary and a family, for the ones a
schema repository is actually written with. Written out by hand rather than lifted from the server's
own help tables, which ship under the GPL.

Offsets are 0-based, counted in UTF-16 code units, with an exclusive end: the LSP convention,
adopted at the bottom of the engine so no layer has to translate positions on the way out.

## Requirements

Node 22.18 or newer. **Working on this repository needs no build**: the `.ts` files run directly
under Node's native type stripping, so the tests, the command and the language server all run from
source in a checkout. 22.18 rather than 22.6 because that is where stripping stopped needing a flag.
Below that floor, `sqldex` and `sqldex-lsp` say so themselves rather than failing at some unrelated
later step. **On Windows**, the official installer at
[nodejs.org](https://nodejs.org) or `winget upgrade OpenJS.NodeJS.LTS` replaces an older install in
place; [nvm-windows](https://github.com/coreybutler/nvm-windows) is the equivalent of `nvm`/`n` for
keeping more than one version around.

**What is published is JavaScript**, and it has to be. Node refuses to strip types from any file
under `node_modules`, by design and with no flag to allow it, so a package shipping `.ts` sources
installs perfectly and then dies at its first import. `npm run build` emits `dist/` and `npm publish`
runs it; the checkout keeps reading `src/` through a `development` export condition, which is what
`npm test` and the editor clients ask for. The same restriction is why the VS Code extension copies
the server *beside* its own code rather than into a `node_modules` — see
[its README](editors/vscode).

**The engine and the command have no runtime dependencies**: installing `sqldex` or depending on
`@sqldex/core` pulls in nothing at all. The language server is a separate package and does have one,
`vscode-languageserver`, which carries the protocol's transport and its types — writing those by
hand would buy nothing that anybody installing a linter would notice. Whoever does not want a
language server does not install it.

## The command

```
sqldex check [paths...]        check the project, or just the paths named
sqldex rules                   every rule, with a one-line summary
sqldex explain <rule-id>       the full reasoning behind one rule
```

```
$ sqldex check sps
sps/sp_settle_orders.sql
  3:11  hint   routine/unused-variable   unused variable: vBatchSize
  5:60  error  query/insert-value-count  orders gets 2 value(s) and expects 3
  7:10  warn   query/unfiltered-write    this UPDATE has no filter: it rewrites the whole of customers

3 findings in 1 file (1 error, 1 warn, 1 hint)
```

`--format` takes `pretty` (the default), `json`, `sarif` for GitHub Code Scanning, `github` for
inline annotations, and `gitlab` for a Code Quality report. `--quiet` drops the hints. Exit codes
are **0** clean, **1** findings above the failure floor — any error, or more warnings than
`--max-warnings` allows — and **2** for a command that could not run at all. A `hint` never fails a
build; that is what makes it a hint.

**`--diff <base>` checks only what changed**, which is the CI shape: `sqldex check --diff
origin/master`. The catalog is still built from the whole project, because a change is judged
against the schema it lands in and not against itself. `--diff auto` reads the base out of the CI
job — `CI_MERGE_REQUEST_DIFF_BASE_SHA`, then `GITHUB_BASE_REF` — and says so rather than guessing a
branch name when neither is set.

**Migration scripts are checked against a catalog that can see them.** A file under
`deploy_folder/` contributes no definitions to the project — its `CREATE TABLE`s are copies of
tables already declared in `tables/` — but a migration is also the one kind of file that declares a
table and then writes to it a few lines down. So each file is read against the project's catalog
plus its own declarations, which is the difference between a useful report and one where a third of
the findings are the file's own tables.

## In an editor

`sqldex-lsp` is the same engine over stdio, and it answers what a schema makes answerable: findings
as you type, what a name is and where it is defined, where its foreign key leads, who else uses it,
what a rename would touch, and the statements the catalog can write for you. It takes no arguments —
which project it serves comes from the `initialize`, and how it behaves comes from that project's
own `.sqldex.json`, so a rule that is off in CI is off in the editor too.

Two clients ship with it, and both are configuration rather than code: one
[for Neovim](editors/nvim) and one for [VS Code](editors/vscode). Any other editor needs the same
three facts: run `sqldex-lsp --stdio`, attach it to SQL buffers, and give it the project directory as the
root.

Neither client decides anything about analysis, and neither offers a setting that would: what is
reported lives in the project's `.sqldex.json` beside the code, where CI reads it too. What they do
decide is when **not** to start — a repository that merely contains a `.sql` file is not a schema
project, and indexing one uninvited is the thing the guard exists to prevent.

## Usage as a library

```ts
import { Catalog, analyze, columnNames, mysql, qualifier, tokenize } from "@sqldex/core";

const catalog = Catalog.build(mysql, "/path/to/schema-repo");
console.log(catalog.stats.tables, "tables,", catalog.stats.routines, "routines");

// What a table holds, and who points at it.
const orders = catalog.table("orders")!;
console.log(orders.columns.map((c) => `${c.name} ${c.type.raw}`));
//  [ 'id int', 'customer_id int', 'status char(1)', 'total decimal(10,2)' ]
console.log(catalog.incomingFks("customers").map((fk) => `${fk.table.name}.${fk.fk.columns}`));
//  [ 'orders.customer_id' ]

// What belongs under the cursor, marked here with `|`:  SELECT o.| FROM orders o
const sql = "SELECT o. FROM orders o";
const offset = sql.indexOf("o.") + 2;
const analysis = analyze(mysql, sql, tokenize(sql).tokens, offset);
console.log(analysis.context);
//  { kind: 'qualified', qualifier: 'o' }

const context = { dialect: mysql, catalog, schemas: new Set(["shop"]) };
const noLocals = { items: [], byName: new Map() };
const resolved = qualifier(context, analysis, noLocals, "o");
console.log(resolved?.kind, columnNames(resolved));
//  table [ 'id', 'customer_id', 'status', 'total' ]
```

The last argument is the routine's locals, so that a temporary table declared in the body shadows
a catalog table of the same name; `collect()` produces it, and the empty scope above is what you
pass for SQL that is not inside a routine. Names are looked up folded, so `catalog.table("Orders")`
finds the same table — how a name folds is the dialect's decision, which is why it is asked rather
than assumed.

## Configuration

None is required. A `.sqldex.json` at the repo root overrides the defaults, and also serves as the
marker that says "this directory is a schema project" when the layout is not one of the recognised
ones:

```json
{
  "sources": [
    { "glob": "schema/**/*.sql", "kind": "tables" },
    { "glob": "procs/**/*.sql", "kind": "routines" }
  ],
  "targets": [
    { "glob": "schema/**/*.sql", "kind": "tables" },
    { "glob": "migrations/**/*.sql", "kind": "auto" }
  ],
  "schemas": ["shop", "shop_audit"],
  "exclude": ["deploy.sql", "rollback.sql"]
}
```

`schemas` is what makes a reference into *another* database resolve to nothing knowable instead of
being checked against a same-named table of this one; it defaults to the root directory's name.

`targets` is **what gets checked**, as against `sources`, which is what builds the catalog. They are
the same list in an editor — you lint what you index — and different in CI, where a migration
directory is code that runs and has to be checked, while contributing no definitions. It defaults to
`sources` plus `deploy_folder/**/*.sql` where that directory exists.

Keys are `snake_case` because this is a file format people write by hand, not the model.

## Rules

Forty-six of them, in five groups that say what a rule is *about* — which is what someone
turning rules off is choosing between:

| Group | Rules |
|---|---|
| `names` | `unknown-table`, `unknown-alias`, `unknown-column`, `unqualified-column`, `unknown-routine`, `ambiguous-column` |
| `schema` | `fk-unknown-table`, `fk-unknown-column`, `fk-missing-index`, `index-unknown-column`, `redundant-index`, `divergent-type`, `no-primary-key`, `fk-type-mismatch`, `duplicate-constraint-name` |
| `query` | `insert-value-count`, `insert-select-column-count`, `insert-unknown-column`, `insert-missing-required-column`, `unfiltered-write`, `write-target-in-subquery`, `join-without-condition`, `collation-mismatch`, `left-join-arithmetic`, `join-multiplies-aggregate`, `nullable-scalar-subquery`, `scalar-subquery-many-rows`, `only-full-group-by`, `aggregate-without-group-by`, `literal-type-mismatch`, `enum-value-not-defined` |
| `routine` | `call-arity`, `out-argument-not-variable`, `cursor-never-opened`, `unused-variable`, `variable-never-assigned`, `dead-coalesce-default`, `exclusive-branch-and`, `nullable-into-arithmetic`, `nullable-variable-in-predicate`, `select-into-arity`, `select-into-many-rows`, `declare-after-statement`, `shadowed-parameter` |
| `audit` | `table-out-of-sync`, `trigger-missing-column` |

Each carries its own reasoning in `rule.docs`, including what it deliberately does **not** flag —
several of these are only usable because they stand down in a case they cannot decide, and that is
worth reading before turning one off as noisy.

Writing your own is the same shape. A rule declares which subject it wants — a file, a routine, a
statement, a `CREATE TABLE`, a trigger — and the engine hands it that subject with the shared work
already done: the relations resolved, the query scopes cut, that routine's own locals gathered. A rule never lexes, never parses and never opens a file; the schema rules
see only the model and the catalog, while the ones asking lexical questions — *is this variable ever
read*, *is this name inside a `COALESCE`* — also get the token stream, because there is nowhere else
for such a fact to live.

```ts
import { check, defaults, Registry, type Rule } from "@sqldex/core";

const noCartesianJoin: Rule = {
  id: "query/join-without-condition",
  group: "query",
  severity: "warn",
  scope: "statement",
  docs: "A JOIN with neither ON nor USING multiplies the two tables together.",
  check(ctx) {
    // The statement's relations arrive already resolved against the catalog.
    if (ctx.relations.length < 2) return;
    const body = ctx.tokens.slice(ctx.statement.from, ctx.statement.to + 1);
    if (body.some((t) => /^(on|using)$/i.test(t.v))) return;
    const at = ctx.relations[1]!;
    ctx.report(at.nameSpan!, "this JOIN has no ON or USING");
  },
};

const registry = new Registry().add(noCartesianJoin);
const sql = "SELECT * FROM orders o JOIN customers c;";
console.log(check(registry, { ...context, config: defaults }, sql));
//  [ { span: { s: 28, e: 37 }, code: 'query/join-without-condition',
//      severity: 'warn', message: 'this JOIN has no ON or USING' } ]
```

`context` is the one built in *Usage as a library* above, plus the config the severities are
resolved against.

A rule's `id` is `group/name`, and it is the whole identity: it appears in the diagnostic, in a
suppression comment and in the config, and the engine refuses an `id` whose prefix disagrees with
its `group`. The five groups — `names`, `schema`, `query`, `routine`, `audit` — say what a rule is
*about*, which is what someone turning rules off is choosing between; how much a finding matters is
`severity`, separately, so the two cannot drift into contradicting each other.

Silencing happens at three widths, and a project file overrides a rule's default severity rather
than only switching it off:

```json
{
  "diagnostics": {
    "enabled": true,
    "groups": { "audit": "off" },
    "rules": { "query/join-without-condition": "error" }
  }
}
```

`enabled` is the one key that only the editor reads: turning it off leaves a repo with the catalog,
the navigation and the completion and none of the underlines, while `sqldex check` goes on reporting
exactly as before. What CI fails on does not move with it.

A key the engine does not read is reported rather than ignored in silence — `diagnostic` for
`diagnostics` leaves every rule on, and the person who wrote it believes otherwise. It stays a
warning and never a failure: a file written for a later version has to keep working on this one.

```sql
-- sqldex:ignore                       -- the next line, whatever the rule
-- sqldex:ignore query/unfiltered-write -- the next line, that rule only
-- sqldex:ignore-file                   -- this file
```

The engine caps a file at 100 findings, and what it drops is chosen rather than whatever arrived
last: an error is never dropped for a warning. A file that was cut says so, with one more entry at
the end counting what is missing — a result that was truncated with no sign of it is the same defect
these rules are about. Two rules can both see one name, and where they would say
the same thing about it one of them declares that it **supersedes** the other — the insert rule over
the bare-column one, say, because it can name the table the column is missing from. That claim is
written on the rule and resolved after everything has been said, so the same findings come out
whatever order the rules were registered in. Where two rules say two different things about one
token, both are reported: an aggregate can be multiplied by a join *and* NULL when nothing matches,
and those are two defects with two fixes.

## Development

```
npm test                        # 572 tests, hand-written fixtures only
npm run typecheck
npm run build                   # emits dist/ for publishing; not needed to develop
npm run bench <dir>...          # lexer throughput over a directory of SQL
npm run check:flat <repo>...    # holds down "auto never finds fewer names"
```

The suite declares no schema and reaches no network: every test builds its project out of fixtures
checked in beside it. The language server's tests are the one part that needs `npm install` first,
since they drive a real connection. The last two tools take a path because they are meaningful only
over a real schema: point them at any repo of `.sql` files you have.

## License

MIT — see [LICENSE](LICENSE).
