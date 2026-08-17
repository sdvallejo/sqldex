/**
 * The whole report, for a script.
 *
 * Positions are given **twice**: the span in offsets, which is what the engine actually computed
 * and the only lossless form, and line/character alongside it. A consumer that has the file could
 * derive the second from the first, but it would have to agree with us on what a character is —
 * UTF-16 code units, 0-based — and the point of an output format is not to make that a shared
 * secret. Both are 0-based; nothing here is quietly one-based.
 */

import type { Report } from "../run.ts";

export function json(report: Report): string {
  return JSON.stringify(
    {
      version: 1,
      root: report.root,
      files: { linted: report.linted, indexed: report.indexed },
      counts: report.counts,
      findings: report.findings.map((finding) => ({
        path: finding.path,
        code: finding.diagnostic.code,
        severity: finding.diagnostic.severity,
        message: finding.diagnostic.message,
        span: finding.diagnostic.span,
        start: finding.start,
        end: finding.end,
        ...(finding.diagnostic.tags ? { tags: finding.diagnostic.tags } : {}),
      })),
    },
    null,
    2,
  );
}
