/**
 * GitHub Actions workflow commands, which put a finding in the diff as an annotation.
 *
 * The escaping is the whole of the difficulty. A workflow command is one line of text with `,` and
 * `::` as structure, so a message carrying either would cut the command short — and it would do so
 * *silently*, producing a plausible annotation with the wrong text rather than an error. The
 * property values and the message escape differently, which is not a mistake here but what the
 * runner does.
 *
 * There is no `hint` level: `notice` is the quietest GitHub has.
 */

import type { Report } from "../run.ts";

const COMMANDS = { error: "error", warn: "warning", hint: "notice" } as const;

/** Inside a property value, where `,` and `:` are structure. */
function escapeProperty(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

/** Inside the message, where only the line breaks have to go. */
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function github(report: Report): string {
  return report.findings
    .map((finding) => {
      const properties = [
        `file=${escapeProperty(finding.path)}`,
        `line=${finding.start.line + 1}`,
        `col=${finding.start.character + 1}`,
        `endLine=${finding.end.line + 1}`,
        `endColumn=${finding.end.character + 1}`,
        `title=${escapeProperty(finding.diagnostic.code)}`,
      ].join(",");
      return `::${COMMANDS[finding.diagnostic.severity]} ${properties}::${escapeData(finding.diagnostic.message)}`;
    })
    .join("\n");
}
