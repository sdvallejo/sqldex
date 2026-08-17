/**
 * `sqldex rules` and `sqldex explain <id>`.
 *
 * Both print `rule.docs` verbatim. That is the point of having written the reasoning next to each
 * rule rather than in a document beside it: there is one copy, it ships in the package, and it
 * cannot fall out of step with the rule it describes.
 */

import type { Registry, Rule } from "@sqldex/core";

/** The summary line: `docs` opens with one sentence, then a blank line, then the reasoning. */
function summary(docs: string): string {
  const [first = ""] = docs.split("\n\n");
  return first.replaceAll("\n", " ").trim();
}

/**
 * Every rule, sorted by `id`.
 *
 * `all()` and not `inOrder()`: the running order is a decision about which rule claims a token
 * first, and showing it to somebody looking for a rule by name would be showing them the engine's
 * internals as if they were a table of contents.
 */
export function listRules(registry: Registry, format: "pretty" | "json"): string {
  const rules = registry.all();
  if (format === "json") {
    return JSON.stringify(
      rules.map((rule) => ({
        id: rule.id,
        group: rule.group,
        severity: rule.severity,
        scope: rule.scope,
        ...(rule.dialects ? { dialects: rule.dialects } : {}),
        summary: summary(rule.docs),
        docs: rule.docs,
      })),
      null,
      2,
    );
  }

  const width = Math.max(...rules.map((rule) => rule.id.length));
  const lines: string[] = [];
  let group: string | undefined;
  for (const rule of rules) {
    if (rule.group !== group) {
      if (group !== undefined) lines.push("");
      group = rule.group;
    }
    lines.push(`  ${rule.id.padEnd(width)}  ${rule.severity.padEnd(5)}  ${summary(rule.docs)}`);
  }
  lines.push("");
  lines.push(`${rules.length} rules. \`sqldex explain <id>\` for the reasoning behind one.`);
  return lines.join("\n");
}

/** The full entry for one rule, or the nearest thing to a suggestion when there is no such id. */
export function explain(registry: Registry, id: string): { text: string; found: boolean } {
  const rule: Rule | undefined = registry.get(id);
  if (!rule) {
    const needle = id.toLowerCase();
    const near = registry
      .all()
      .filter((candidate) => candidate.id.includes(needle) || candidate.id.split("/")[1] === needle);
    const lines = [`no rule called ${id}`];
    if (near.length > 0) {
      lines.push("", "did you mean:", ...near.map((candidate) => `  ${candidate.id}`));
    } else {
      lines.push("", "`sqldex rules` lists them all.");
    }
    return { text: lines.join("\n"), found: false };
  }

  const header = [`${rule.id}`, `${rule.group} · ${rule.severity} · ${rule.scope}`];
  if (rule.dialects) header.push(`only on: ${rule.dialects.join(", ")}`);
  return { text: [...header, "", rule.docs].join("\n"), found: true };
}
