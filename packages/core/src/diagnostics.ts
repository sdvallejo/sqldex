/**
 * What a rule produces.
 *
 * Deliberately not LSP's `Diagnostic`, though it is a short hop from one: a `Span` instead of a
 * `Range`, a string severity instead of `1 | 2 | 3 | 4`, and a string tag instead of a number.
 * The core owes nothing to a protocol, and the layer that speaks one converts on its way out —
 * which is one function, once, rather than every producer having to know the wire format.
 */

import type { Span } from "./syntax/types.ts";

/**
 * How much a finding deserves.
 *
 * `error` is reserved for what **the engine itself would reject at execution time**: a `CALL` with
 * the wrong number of arguments, or a positional `INSERT` that has gone stale, are not arguable —
 * they fail. Everything else is a `warn`, because those are heuristics over code that cannot be
 * checked against a live database, and a red error that turns out to be debatable teaches you to
 * ignore all the others. `hint` is for what is merely surplus: a dead variable breaks nothing and
 * changes no result, and mixing it in with the schema warnings would make those read as milder
 * than they are.
 */
export type Severity = "error" | "warn" | "hint";

/**
 * Extra meaning about *why* something is reported, when the severity does not carry it.
 *
 * `unnecessary` is what makes an editor grey the name out instead of underlining it, which is
 * exactly right for a variable nobody reads: the code is not wrong, it is surplus.
 */
export type DiagnosticTag = "unnecessary";

export interface Diagnostic {
  /** Where it is, in the offsets the whole core uses. */
  span: Span;
  /** The rule's `id`, so a reader can look it up and a config can silence exactly this. */
  code: string;
  severity: Severity;
  message: string;
  tags?: DiagnosticTag[];
}
