/**
 * The format a person reads, and the default.
 *
 * Grouped by file with the path written once, because a sweep of a schema repo reports several
 * findings per file and repeating the path on every line pushes the message off the right edge of
 * the terminal. The columns are padded to the widest entry **within a file** rather than across the
 * whole run: aligning globally means one 400-line file sets the indent for every three-line one.
 */

import type { Report } from "../run.ts";

/** ANSI, or the identity when colour is off. Assembled once so the formatter has no branches. */
export interface Paint {
  dim(s: string): string;
  bold(s: string): string;
  error(s: string): string;
  warn(s: string): string;
  hint(s: string): string;
}

const plain = (s: string): string => s;

export const noColor: Paint = { dim: plain, bold: plain, error: plain, warn: plain, hint: plain };

export const color: Paint = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  error: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  hint: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Colour is on when the output is a terminal and nobody asked otherwise.
 *
 * `NO_COLOR` is honoured whatever its value, including empty, which is what the convention says:
 * its presence is the signal.
 */
export function paintFor(isTTY: boolean, env: Record<string, string | undefined>): Paint {
  if (env["NO_COLOR"] !== undefined) return noColor;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return color;
  return isTTY ? color : noColor;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function pretty(report: Report, paint: Paint): string {
  const lines: string[] = [];
  const label = { error: paint.error("error"), warn: paint.warn("warn "), hint: paint.hint("hint ") };

  let last: string | undefined;
  let group: typeof report.findings = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const width = Math.max(...group.map((f) => `${f.start.line + 1}:${f.start.character + 1}`.length));
    const codeWidth = Math.max(...group.map((f) => f.diagnostic.code.length));
    for (const finding of group) {
      const at = `${finding.start.line + 1}:${finding.start.character + 1}`.padEnd(width);
      lines.push(
        `  ${paint.dim(at)}  ${label[finding.diagnostic.severity]}  ` +
          `${paint.dim(finding.diagnostic.code.padEnd(codeWidth))}  ${finding.diagnostic.message}`,
      );
    }
    group = [];
  };

  for (const finding of report.findings) {
    if (finding.path !== last) {
      flush();
      if (last !== undefined) lines.push("");
      lines.push(paint.bold(finding.path));
      last = finding.path;
    }
    group.push(finding);
  }
  flush();

  const { error, warn, hint } = report.counts;
  const total = error + warn + hint;
  if (total === 0) {
    lines.push(paint.dim(`no findings in ${plural(report.linted, "file")}`));
  } else {
    lines.push("");
    lines.push(
      `${plural(total, "finding")} in ${plural(report.linted, "file")} ` +
        paint.dim(`(${error} error, ${warn} warn, ${hint} hint)`),
    );
  }
  return lines.join("\n");
}
