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
import { ambiguousColumn } from "./names/ambiguous-column.ts";
import { Registry } from "./registry.ts";
import { cursorNeverOpened } from "./routine/cursor-never-opened.ts";
import { nullableIntoArithmetic } from "./routine/nullable-into-arithmetic.ts";
import { unusedVariable } from "./routine/unused-variable.ts";
import { variableNeverAssigned } from "./routine/variable-never-assigned.ts";
import { divergentType } from "./schema/divergent-type.ts";
import { fkMissingIndex } from "./schema/fk-missing-index.ts";
import { fkUnknownColumn } from "./schema/fk-unknown-column.ts";
import { fkUnknownTable } from "./schema/fk-unknown-table.ts";
import { indexUnknownColumn } from "./schema/index-unknown-column.ts";
import { noPrimaryKey } from "./schema/no-primary-key.ts";
import { redundantIndex } from "./schema/redundant-index.ts";

/**
 * The rules that read the whole file, in running order.
 *
 * They go before the schema rules because that is what "the whole file" means: whether a variable is
 * ever read, or whether a name is ambiguous in its query, is a question you can only answer having
 * looked at everything.
 *
 * The collision inside this group is between the two variable rules — a read can be both the first
 * unprotected read of a never-assigned variable and a use of a nullable-tainted one. "Never assigned"
 * goes first because it is the stronger claim: that read cannot be anything but NULL, where the other
 * says it might be.
 */
export const documentRules = [
  unusedVariable,
  variableNeverAssigned,
  nullableIntoArithmetic,
  ambiguousColumn,
  cursorNeverOpened,
] as const;

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
  return new Registry().add(...documentRules, ...schemaRules);
}

export {
  ambiguousColumn,
  auditTableOutOfSync,
  auditTriggerMissingColumn,
  cursorNeverOpened,
  divergentType,
  fkMissingIndex,
  fkUnknownColumn,
  fkUnknownTable,
  indexUnknownColumn,
  noPrimaryKey,
  nullableIntoArithmetic,
  redundantIndex,
  unusedVariable,
  variableNeverAssigned,
};
