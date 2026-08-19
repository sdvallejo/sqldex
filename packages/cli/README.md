# sqldex

*Gotta index 'em all!*

Static analysis for MySQL schemas that live as `.sql` files in a repository.

A repo full of `CREATE TABLE` and `CREATE PROCEDURE` files **is** a database schema, but no tool
treats it as one. sqldex reads the whole repo and builds a catalog — tables, columns, indexes,
foreign keys, triggers, routines and the temporary tables procedures pass around — and then checks
the SQL written against it. No database connection, no credentials, nothing running.

```sh
npm install -g sqldex
```

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

39 rules in five groups, `--format` for `pretty`, `json`, `sarif`, `github` and `gitlab`, and
`--diff <base>` to check only what a branch changed. It needs no configuration: two common directory
layouts are recognised on sight, and anything else works by sweeping `**/*.sql`.

**In your editor**, the same engine runs as a language server — [`@sqldex/lsp`](https://www.npmjs.com/package/@sqldex/lsp),
with clients for Neovim and VS Code. **As a library**, the catalog and the rule engine are
[`@sqldex/core`](https://www.npmjs.com/package/@sqldex/core).

Full documentation, the rule list and the reasoning behind each one:
**https://github.com/sdvallejo/sqldex**

MIT.
