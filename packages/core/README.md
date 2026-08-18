# @sqldex/core

*Gotta index 'em all!*

The engine behind [sqldex](https://github.com/sdvallejo/sqldex): a catalog built from a repository
of MySQL `.sql` files, the name resolution an editor needs, and the rule engine that checks the SQL
written against it. **No runtime dependencies**, and no database connection.

```sh
npm install @sqldex/core
```

```ts
import { Catalog, mysql } from "@sqldex/core";

const catalog = Catalog.build(mysql, "/path/to/schema-repo");
const orders = catalog.table("orders")!;

console.log(orders.columns.map((c) => `${c.name} ${c.type.raw}`));
console.log(catalog.incomingFks("customers").map((fk) => `${fk.table.name}.${fk.fk.columns}`));
```

What it gives you: the catalog (tables, columns, indexes, foreign keys, triggers, routines and the
temporary tables procedures pass around), name resolution that understands aliases, `NEW`/`OLD`,
CTEs, derived tables and temporary tables, cursor-position analysis for completion, project-wide
reference finding over whole identifier tokens, and a rule registry you can add your own rules to.

Most people want the command instead: [`sqldex`](https://www.npmjs.com/package/sqldex). For an
editor, [`@sqldex/lsp`](https://www.npmjs.com/package/@sqldex/lsp).

API documentation and the design behind it:
**https://github.com/sdvallejo/sqldex**

MIT.
