/**
 * The one conversion from a `SyntaxError` to `@sqldex/core`'s `Diagnostic`, shared by every
 * consumer — the CLI and the language server both turn this package's findings into the same shape
 * everything else in `sqldex check`/the editor already speaks, and a copy of this mapping in each
 * would be two places the code and the message text could drift apart.
 */

import type { Diagnostic } from "@sqldex/core";
import type { SyntaxError } from "./errors.ts";

/** Not a rule id — `group/kebab-case` — on purpose: nothing can silence it via `-- sqldex:ignore`, the same convention `sqldex:capped` already uses for a note that isn't a rule finding either. */
export const SYNTAX_ERROR_CODE = "sqldex:syntax-error";

export function toDiagnostic(error: SyntaxError): Diagnostic {
  return {
    span: error.span,
    code: SYNTAX_ERROR_CODE,
    // Always `error`: `@sqldex/core`'s own `Diagnostic` docs reserve that severity for what the
    // engine itself would reject outright, and nothing is a cleaner fit than a file that does not
    // parse — MySQL's own server would refuse it too.
    severity: "error",
    message: `syntax error: ${error.message}`,
  };
}

export function toDiagnostics(errors: readonly SyntaxError[]): Diagnostic[] {
  return errors.map(toDiagnostic);
}
