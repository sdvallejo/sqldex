/** Small things more than one rule needs, and that mean nothing on their own. */

/**
 * Is `wanted` the leftmost prefix of `columns`, position by position?
 *
 * Position is the whole point. An index on `(register_id, store_id)` cannot serve a lookup by
 * `(store_id, register_id)`: the engine reads an index left to right, so the first column has to
 * be the first column. Comparing the two as sets — or, worse, as their names joined together —
 * would call that covered, and the mistake it would then miss is the common one.
 */
export function isLeftPrefix(wanted: readonly string[], columns: readonly string[]): boolean {
  if (wanted.length > columns.length) return false;
  return wanted.every((name, i) => columns[i]!.toLowerCase() === name.toLowerCase());
}

/**
 * Schemas the engine itself owns.
 *
 * Their tables are not in an application's DDL repo and are not supposed to be, so a reference to
 * one is not a dangling reference — it is a reference to something this repo was never going to
 * define.
 */
export const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "information_schema",
  "performance_schema",
  "mysql",
  "sys",
]);
