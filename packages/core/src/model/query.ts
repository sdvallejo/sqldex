/** The IR for what a statement declares: its relations, and the query scopes inside it. */

import type { Span, TokenRange } from "../syntax/types.ts";

export interface Relation {
  /** Absent for a derived table `(SELECT ...) x`. */
  name?: string;
  quoted?: boolean;
  alias?: string;
  aliasQuoted?: boolean;
  /** Explicit schema, as in `information_schema.TABLES`. */
  schema?: string;
  /** The subquery's token range, when it is one. */
  derived?: TokenRange;
  /** The name is a `WITH` of this same statement, not a catalog table. */
  cte?: boolean;
  /** Offset of the name — of the opening `(` for a derived table, which has none. */
  offset: number;
  /** Span of the name, for goto-definition. Absent exactly when `name` is. */
  nameSpan?: Span;
}

/**
 * One `SELECT`, `UPDATE`, `DELETE`, `INSERT` or `REPLACE`, and everything it encloses.
 *
 * This is a finer cut than a statement, and it is the one that answers "what does this name
 * resolve to" — see `queryScopes` for why the two cuts both have to exist.
 */
export interface QueryScope extends TokenRange {
  /** Parenthesis depth it was opened at. */
  depth: number;
  /** The scope that encloses it. */
  parent?: QueryScope;
}
