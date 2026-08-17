/**
 * The mirror-table convention these rules are about.
 *
 * A schema that keeps history does it with a twin table per audited table — `aud_orders` beside
 * `orders` — and three triggers that copy every row into it. Nothing enforces the pairing, so the
 * twin drifts: a column is added to the table and not to its mirror, and the audit trail quietly
 * stops covering it.
 *
 * This is a convention and not a law, which is why both rules **only fire where it is already in
 * use**: no twin, nothing to say.
 */
export const AUDIT_PREFIX = "aud_";

/** The name a table's twin would have. */
export function auditTableName(table: string): string {
  return AUDIT_PREFIX + table;
}
