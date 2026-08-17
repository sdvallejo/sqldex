# sqldex

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

## Status

**Early. This is a library, not a tool yet.** The analysis engine is complete and tested, and rules
can be written against it — but none ship, and there is no command to run them with. Nothing is
published to npm.

| | |
|---|---|
| Catalog and name resolution | works |
| Rule engine | works — registry, traversals, suppression, per-rule severity |
| The rules themselves | none written yet |
| `sqldex` CLI | not built |
| Language server, editor extensions | not built |
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

Offsets are 0-based, counted in UTF-16 code units, with an exclusive end: the LSP convention,
adopted at the bottom of the engine so no layer has to translate positions on the way out.

## Requirements

Node 22.6 or newer, and nothing else. The `.ts` files run directly under Node's native type
stripping, so there is no build step, and the engine has no runtime dependencies.

## Usage

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
  "schemas": ["shop", "shop_audit"],
  "exclude": ["deploy.sql", "rollback.sql"]
}
```

`schemas` is what makes a reference into *another* database resolve to nothing knowable instead of
being checked against a same-named table of this one; it defaults to the root directory's name.
Keys are `snake_case` because this is a file format people write by hand, not the model.

## Rules

The engine is there; no rules ship with it yet. A rule declares what it is about and which subject
it wants, and the engine hands it that subject with the shared work already done — the rule never
lexes, parses or reads a file:

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

`context` is the one built in *Usage* above, plus the config the severities are resolved against.

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
    "groups": { "audit": "off" },
    "rules": { "query/join-without-condition": "error" }
  }
}
```

```sql
-- sqldex:ignore                       -- the next line, whatever the rule
-- sqldex:ignore query/unfiltered-write -- the next line, that rule only
-- sqldex:ignore-file                   -- this file
```

The engine caps a file at 100 findings, and reports a given token once: two rules can both see a
name, and hearing about it twice makes you look for two problems. The first rule registered wins,
which is why registration order is deliberate and listing order is not.

## Development

```
npm test                        # 58 tests, hand-written fixtures only
npm run typecheck
npm run bench <dir>...          # lexer throughput over a directory of SQL
npm run check:flat <repo>...    # holds down "auto never finds fewer names"
```

The test suite needs nothing but a checkout. The last two tools take a path because they are
meaningful only over a real schema: point them at any repo of `.sql` files you have.

## License

MIT — see [LICENSE](LICENSE).
