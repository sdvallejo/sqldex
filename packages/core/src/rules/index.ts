/**
 * Every rule sqldex ships.
 *
 * **The order is no longer the file's reason for existing**, and that is the point of how it reads
 * now. It used to be: de-duplication was first-come, so where two rules saw one token the one listed
 * first was the one that got to speak, and every collision had to be argued for in prose here and
 * held down by a test that could only check the symptom. A rule added in the wrong position changed
 * another rule's output with nothing to say so.
 *
 * A rule now declares what it displaces — `supersedes` — beside the argument for it, and the engine
 * resolves collisions after everything has been said, so the same findings come out whatever order
 * they went in. What is left here is grouping by scope, which is about what the engine has to
 * compute before calling a rule and not about who wins.
 *
 * The five declarations that exist, each on the rule that makes the claim: the insert rule over the
 * bare-column one, the many-rows subquery over the NULL one, "never assigned" over the taint rule,
 * the taint rule over the predicate one, and the audit drift over the type outlier.
 *
 * And one pair that deliberately has **no** declaration: an aggregate can be both multiplied by a
 * join and NULL when nothing matches. Two defects, two fixes, both said.
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
import { literalTypeMismatch } from "./query/literal-type-mismatch.ts";
import { nullableScalarSubquery } from "./query/nullable-scalar-subquery.ts";
import { onlyFullGroupBy } from "./query/only-full-group-by.ts";
import { scalarSubqueryManyRows } from "./query/scalar-subquery-many-rows.ts";
import { unfilteredWrite } from "./query/unfiltered-write.ts";
import { callArity } from "./routine/call-arity.ts";
import { outArgumentNotVariable } from "./routine/out-argument-not-variable.ts";
import { selectIntoManyRows } from "./routine/select-into-many-rows.ts";
import { Registry } from "./registry.ts";
import { cursorNeverOpened } from "./routine/cursor-never-opened.ts";
import { declareAfterStatement } from "./routine/declare-after-statement.ts";
import { nullableIntoArithmetic } from "./routine/nullable-into-arithmetic.ts";
import { nullableVariableInPredicate } from "./routine/nullable-variable-in-predicate.ts";
import { unusedVariable } from "./routine/unused-variable.ts";
import { variableNeverAssigned } from "./routine/variable-never-assigned.ts";
import { divergentType } from "./schema/divergent-type.ts";
import { duplicateConstraintName } from "./schema/duplicate-constraint-name.ts";
import { fkMissingIndex } from "./schema/fk-missing-index.ts";
import { fkTypeMismatch } from "./schema/fk-type-mismatch.ts";
import { fkUnknownColumn } from "./schema/fk-unknown-column.ts";
import { fkUnknownTable } from "./schema/fk-unknown-table.ts";
import { indexUnknownColumn } from "./schema/index-unknown-column.ts";
import { noPrimaryKey } from "./schema/no-primary-key.ts";
import { redundantIndex } from "./schema/redundant-index.ts";

/**
 * The rules that read the whole file.
 *
 * What they have in common is the question they ask: whether a variable is ever read, or whether a
 * name is ambiguous in its query, can only be answered having looked at everything.
 */
export const documentRules = [
  declareAfterStatement,
  unusedVariable,
  variableNeverAssigned,
  nullableIntoArithmetic,
  nullableVariableInPredicate,
  ambiguousColumn,
  cursorNeverOpened,
] as const;

/**
 * The rules that read one statement, with its relations already resolved.
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
  selectIntoManyRows,
  nullableScalarSubquery,
  onlyFullGroupBy,
  literalTypeMismatch,
  collationMismatch,
  unfilteredWrite,
  joinWithoutCondition,
] as const;

/** The rules that read a `CREATE TABLE` or a `CREATE TRIGGER`. */
export const schemaRules = [
  auditTableOutOfSync,
  fkUnknownColumn,
  fkUnknownTable,
  fkMissingIndex,
  fkTypeMismatch,
  duplicateConstraintName,
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
  declareAfterStatement,
  divergentType,
  duplicateConstraintName,
  fkMissingIndex,
  fkUnknownColumn,
  fkTypeMismatch,
  fkUnknownTable,
  indexUnknownColumn,
  insertUnknownColumn,
  insertValueCount,
  joinMultipliesAggregate,
  joinWithoutCondition,
  leftJoinArithmetic,
  literalTypeMismatch,
  noPrimaryKey,
  nullableIntoArithmetic,
  onlyFullGroupBy,
  nullableScalarSubquery,
  nullableVariableInPredicate,
  outArgumentNotVariable,
  redundantIndex,
  scalarSubqueryManyRows,
  selectIntoManyRows,
  unfilteredWrite,
  unknownAlias,
  unknownColumn,
  unknownRoutine,
  unknownTable,
  unqualifiedColumn,
  unusedVariable,
  variableNeverAssigned,
};
