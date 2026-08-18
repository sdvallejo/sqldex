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
import { unknownAlias } from "./names/unknown-alias.ts";
import { unknownColumn } from "./names/unknown-column.ts";
import { unknownRoutine } from "./names/unknown-routine.ts";
import { unknownTable } from "./names/unknown-table.ts";
import { unqualifiedColumn } from "./names/unqualified-column.ts";
import { collationMismatch } from "./query/collation-mismatch.ts";
import { insertUnknownColumn } from "./query/insert-unknown-column.ts";
import { insertValueCount } from "./query/insert-value-count.ts";
import { joinMultipliesAggregate } from "./query/join-multiplies-aggregate.ts";
import { joinWithoutCondition } from "./query/join-without-condition.ts";
import { leftJoinArithmetic } from "./query/left-join-arithmetic.ts";
import { nullableScalarSubquery } from "./query/nullable-scalar-subquery.ts";
import { scalarSubqueryManyRows } from "./query/scalar-subquery-many-rows.ts";
import { unfilteredWrite } from "./query/unfiltered-write.ts";
import { callArity } from "./routine/call-arity.ts";
import { outArgumentNotVariable } from "./routine/out-argument-not-variable.ts";
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

/**
 * The rules that read one statement, in running order.
 *
 * The order follows the dispatch it was taken from, and two pairs in it matter:
 *
 *   - An `INSERT`'s column list is read by `query/insert-unknown-column` **before**
 *     `names/unqualified-column` sees the same tokens as bare names. Both would report a column that
 *     does not exist there; the insert rule says which table it is missing from, so it goes first.
 *   - `query/join-multiplies-aggregate` goes before `query/nullable-scalar-subquery`, because both
 *     report on the aggregate's own name token and `SET x = (SELECT SUM(o.total) FROM o JOIN …) + 1`
 *     is both things at once. The fan-out wins: it names the join and the key that is not unique
 *     there, where the other has only "and it could also have been NULL" to add.
 *   - `query/scalar-subquery-many-rows` goes before `query/nullable-scalar-subquery`, which report on
 *     the same `SELECT` token whenever an unpinned search is read as a number. Both come of the same
 *     missing key, and the many-rows one is the actionable end of it: pinning the key answers both,
 *     where a `COALESCE` around the sum leaves the statement still able to fail with error 1242.
 *
 * `rules-statement.test.ts` holds all three down.
 */
export const statementRules = [
  unknownTable,
  unknownAlias,
  unknownColumn,
  unknownRoutine,
  callArity,
  outArgumentNotVariable,
  insertUnknownColumn,
  insertValueCount,
  unqualifiedColumn,
  leftJoinArithmetic,
  joinMultipliesAggregate,
  scalarSubqueryManyRows,
  nullableScalarSubquery,
  collationMismatch,
  unfilteredWrite,
  joinWithoutCondition,
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
  return new Registry().add(...documentRules, ...schemaRules, ...statementRules);
}

export {
  ambiguousColumn,
  auditTableOutOfSync,
  auditTriggerMissingColumn,
  callArity,
  collationMismatch,
  cursorNeverOpened,
  divergentType,
  fkMissingIndex,
  fkUnknownColumn,
  fkUnknownTable,
  indexUnknownColumn,
  insertUnknownColumn,
  insertValueCount,
  joinMultipliesAggregate,
  joinWithoutCondition,
  leftJoinArithmetic,
  noPrimaryKey,
  nullableIntoArithmetic,
  nullableScalarSubquery,
  outArgumentNotVariable,
  redundantIndex,
  scalarSubqueryManyRows,
  unfilteredWrite,
  unknownAlias,
  unknownColumn,
  unknownRoutine,
  unknownTable,
  unqualifiedColumn,
  unusedVariable,
  variableNeverAssigned,
};
