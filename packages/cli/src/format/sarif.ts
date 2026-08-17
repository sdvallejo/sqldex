/**
 * SARIF 2.1.0, which is what GitHub Code Scanning ingests.
 *
 * Two things about this format are easy to get subtly wrong, so they are done in the open here:
 *
 *   - **Regions are 1-based.** Everything inside sqldex is 0-based, LSP-style, from the lexer up.
 *     The `+ 1`s below are the only place that changes, and they are all in one function.
 *   - **`endColumn` is exclusive**, pointing one past the last character of the region. That is the
 *     same convention as our own spans, so the arithmetic is the same `+ 1` and not a `+ 2`.
 *
 * The rules array carries **every** rule, not only the ones that fired. Code Scanning uses it to
 * describe a finding in its UI and to keep an alert's identity across runs, and a rule that appears
 * only in the runs where it fired makes the second of those unstable.
 */

import type { Rule } from "@sqldex/core";

import type { Report } from "../run.ts";

/** sqldex's three severities, in SARIF's vocabulary. */
const LEVELS = { error: "error", warn: "warning", hint: "note" } as const;

/** The summary line: `docs` opens with one sentence, then a blank line, then the reasoning. */
function summary(docs: string): string {
  const [first = ""] = docs.split("\n\n");
  return first.replaceAll("\n", " ").trim();
}

export function sarif(report: Report, rules: readonly Rule[], version: string): string {
  const index = new Map(rules.map((rule, i) => [rule.id, i]));

  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "sqldex",
              version,
              rules: rules.map((rule) => ({
                id: rule.id,
                name: rule.id,
                shortDescription: { text: summary(rule.docs) },
                fullDescription: { text: rule.docs },
                defaultConfiguration: { level: LEVELS[rule.severity] },
                properties: { tags: [rule.group] },
              })),
            },
          },
          results: report.findings.map((finding) => ({
            ruleId: finding.diagnostic.code,
            ...(index.has(finding.diagnostic.code) ? { ruleIndex: index.get(finding.diagnostic.code) } : {}),
            level: LEVELS[finding.diagnostic.severity],
            message: { text: finding.diagnostic.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: finding.path, uriBaseId: "%SRCROOT%" },
                  region: {
                    startLine: finding.start.line + 1,
                    startColumn: finding.start.character + 1,
                    endLine: finding.end.line + 1,
                    endColumn: finding.end.character + 1,
                  },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}
