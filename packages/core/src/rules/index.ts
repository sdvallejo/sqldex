/**
 * Every rule, and the order they run in.
 *
 * **The order is the file's reason for existing.** De-duplication is first-come, so where two rules
 * can see the same token the one registered first is the one that gets to speak — and that has to
 * be a decision written down, not a consequence of how a `Map` happens to iterate. The rule with the
 * more specific thing to say goes first.
 *
 * Within the table traversal the two collisions that actually happen:
 *
 *   - A column missing from the `aud_` twin **and** an outlier type: both would report on the
 *     column's name. The audit drift is the concrete fact, so it goes first.
 *   - A foreign key's own column that does not exist, against everything else about that key: the
 *     column is the specific thing.
 */

import { auditTableOutOfSync } from "./audit/table-out-of-sync.ts";
import { auditTriggerMissingColumn } from "./audit/trigger-missing-column.ts";
import { Registry } from "./registry.ts";
import { divergentType } from "./schema/divergent-type.ts";
import { fkMissingIndex } from "./schema/fk-missing-index.ts";
import { fkUnknownColumn } from "./schema/fk-unknown-column.ts";
import { fkUnknownTable } from "./schema/fk-unknown-table.ts";
import { indexUnknownColumn } from "./schema/index-unknown-column.ts";
import { noPrimaryKey } from "./schema/no-primary-key.ts";
import { redundantIndex } from "./schema/redundant-index.ts";

/** The rules that read a `CREATE TABLE` or a `CREATE TRIGGER`, in running order. */
export const schemaRules = [
  auditTableOutOfSync,
  fkUnknownColumn,
  fkUnknownTable,
  fkMissingIndex,
  indexUnknownColumn,
  redundantIndex,
  divergentType,
  noPrimaryKey,
  auditTriggerMissingColumn,
] as const;

/**
 * Every rule sqldex ships.
 *
 * A function rather than a shared instance: a registry is mutable, and a caller that wants to add
 * a rule of its own should not be editing everybody else's.
 */
export function allRules(): Registry {
  return new Registry().add(...schemaRules);
}

export {
  auditTableOutOfSync,
  auditTriggerMissingColumn,
  divergentType,
  fkMissingIndex,
  fkUnknownColumn,
  fkUnknownTable,
  indexUnknownColumn,
  noPrimaryKey,
  redundantIndex,
};
