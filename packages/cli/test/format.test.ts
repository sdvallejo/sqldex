/**
 * The five output formats, against one hand-written report.
 *
 * Every case here is about a contract somebody else wrote: SARIF's 1-based regions, GitHub's
 * escaping, GitLab's fingerprints. None of those fail loudly when they are wrong — a mis-escaped
 * workflow command produces a plausible annotation with the wrong text, and an unstable fingerprint
 * produces a merge request where every finding looks new. So they are asserted on whole, not
 * sampled.
 *
 * The report is built by hand rather than swept from a fixture: the point is what the formatter
 * does with a given finding, and reaching that finding through a catalog would make a change to a
 * rule break a test about JSON.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Rule } from "@sqldex/core";

import { github } from "../src/format/github.ts";
import { gitlab } from "../src/format/gitlab.ts";
import { json } from "../src/format/json.ts";
import { noColor, paintFor, pretty } from "../src/format/pretty.ts";
import { sarif } from "../src/format/sarif.ts";
import type { Finding, Report } from "../src/run.ts";

function finding(
  path: string,
  line: number,
  character: number,
  code: string,
  severity: "error" | "warn" | "hint",
  message: string,
): Finding {
  return {
    path,
    absolute: `/repo/${path}`,
    diagnostic: { span: { s: 100, e: 110 }, code, severity, message },
    start: { line, character },
    end: { line, character: character + 10 },
  };
}

const REPORT: Report = {
  root: "/repo",
  linted: 3,
  indexed: 12,
  ms: 42,
  counts: { error: 1, warn: 2, hint: 0 },
  findings: [
    finding("tables/orders.sql", 4, 2, "schema/fk-unknown-table", "error", "no table called shipments"),
    finding("sps/sp_settle.sql", 11, 0, "query/unfiltered-write", "warn", "this UPDATE has no filter"),
    finding("sps/sp_settle.sql", 30, 6, "names/unknown-table", "warn", "unknown table: shipments"),
  ],
};

// ----------------------------------------------------------------------- pretty

test("pretty groups by file and pads within each group", () => {
  assert.equal(
    pretty(REPORT, noColor),
    [
      "tables/orders.sql",
      "  5:3  error  schema/fk-unknown-table  no table called shipments",
      "",
      "sps/sp_settle.sql",
      "  12:1  warn   query/unfiltered-write  this UPDATE has no filter",
      "  31:7  warn   names/unknown-table     unknown table: shipments",
      "",
      "3 findings in 3 files (1 error, 2 warn, 0 hint)",
    ].join("\n"),
  );
});

test("pretty says so when there is nothing to say", () => {
  const empty: Report = { ...REPORT, findings: [], counts: { error: 0, warn: 0, hint: 0 } };
  assert.equal(pretty(empty, noColor), "no findings in 3 files");
});

test("NO_COLOR wins over a terminal", () => {
  assert.equal(paintFor(true, { NO_COLOR: "" }), noColor);
  assert.notEqual(paintFor(true, {}), noColor);
  assert.equal(paintFor(false, {}), noColor);
  assert.notEqual(paintFor(false, { FORCE_COLOR: "1" }), noColor);
});

// ------------------------------------------------------------------------- json

test("json gives offsets and positions, both 0-based", () => {
  const parsed = JSON.parse(json(REPORT));
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.counts, { error: 1, warn: 2, hint: 0 });
  assert.deepEqual(parsed.findings[0], {
    path: "tables/orders.sql",
    code: "schema/fk-unknown-table",
    severity: "error",
    message: "no table called shipments",
    span: { s: 100, e: 110 },
    start: { line: 4, character: 2 },
    end: { line: 4, character: 12 },
  });
});

// ------------------------------------------------------------------------ sarif

const RULES: Rule[] = [
  {
    id: "query/unfiltered-write",
    group: "query",
    severity: "warn",
    scope: "statement",
    docs: "An `UPDATE` or `DELETE` with nothing to narrow it.\n\nIt rewrites the whole table.",
    check: () => undefined,
  },
];

test("sarif regions are 1-based and its end column is exclusive", () => {
  const parsed = JSON.parse(sarif(REPORT, RULES, "1.2.3"));
  const region = parsed.runs[0].results[0].locations[0].physicalLocation.region;
  // The finding sits at 0-based line 4, character 2, ten units wide.
  assert.deepEqual(region, { startLine: 5, startColumn: 3, endLine: 5, endColumn: 13 });
});

test("sarif describes every rule, not only the ones that fired", () => {
  const parsed = JSON.parse(sarif(REPORT, RULES, "1.2.3"));
  const driver = parsed.runs[0].tool.driver;
  assert.equal(driver.version, "1.2.3");
  assert.equal(driver.rules.length, 1);
  assert.equal(driver.rules[0].shortDescription.text, "An `UPDATE` or `DELETE` with nothing to narrow it.");
  assert.match(driver.rules[0].fullDescription.text, /rewrites the whole table/);
  assert.equal(driver.rules[0].defaultConfiguration.level, "warning");
  // The result points into that array by index, which is what keeps an alert's identity stable.
  const fired = parsed.runs[0].results[1];
  assert.equal(fired.ruleId, "query/unfiltered-write");
  assert.equal(fired.ruleIndex, 0);
});

test("sarif has no ruleIndex for a rule it was not given", () => {
  // A caller can pass a narrower registry than the one that ran. An index into an array that does
  // not hold the rule is worse than no index at all: it names a different rule.
  const parsed = JSON.parse(sarif(REPORT, RULES, "1.2.3"));
  assert.equal(parsed.runs[0].results[0].ruleId, "schema/fk-unknown-table");
  assert.equal("ruleIndex" in parsed.runs[0].results[0], false);
});

test("sarif levels are SARIF's three, not sqldex's", () => {
  const withHint: Report = {
    ...REPORT,
    findings: [finding("a.sql", 0, 0, "schema/no-primary-key", "hint", "no primary key")],
  };
  assert.equal(JSON.parse(sarif(withHint, [], "0")).runs[0].results[0].level, "note");
});

// ----------------------------------------------------------------------- github

test("github writes one workflow command per finding", () => {
  assert.equal(
    github(REPORT),
    [
      "::error file=tables/orders.sql,line=5,col=3,endLine=5,endColumn=13," +
        "title=schema/fk-unknown-table::no table called shipments",
      "::warning file=sps/sp_settle.sql,line=12,col=1,endLine=12,endColumn=11," +
        "title=query/unfiltered-write::this UPDATE has no filter",
      "::warning file=sps/sp_settle.sql,line=31,col=7,endLine=31,endColumn=17," +
        "title=names/unknown-table::unknown table: shipments",
    ].join("\n"),
  );
});

test("github escapes what would otherwise cut a command short", () => {
  const awkward: Report = {
    ...REPORT,
    findings: [finding("a,b.sql", 0, 0, "names/unknown-table", "hint", "a: b, c\nd 100%")],
  };
  const line = github(awkward);
  // A comma or a colon inside a property value ends it; inside the message they are ordinary.
  assert.match(line, /file=a%2Cb\.sql/);
  assert.match(line, /::a: b, c%0Ad 100%25$/);
  assert.match(line, /^::notice /);
});

// ----------------------------------------------------------------------- gitlab

test("gitlab carries the fields the widget reads", () => {
  const parsed = JSON.parse(gitlab(REPORT));
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    { ...parsed[0], fingerprint: "…" },
    {
      description: "no table called shipments",
      check_name: "schema/fk-unknown-table",
      fingerprint: "…",
      severity: "major",
      location: { path: "tables/orders.sql", lines: { begin: 5 } },
    },
  );
  assert.deepEqual(
    parsed.map((entry: { severity: string }) => entry.severity),
    ["major", "minor", "minor"],
  );
});

test("a fingerprint survives the finding moving down the file", () => {
  // Somebody adding a line above a finding has not created a new finding, and a fingerprint with
  // the line number in it would tell GitLab otherwise on every merge request.
  const moved: Report = {
    ...REPORT,
    findings: REPORT.findings.map((f) => ({ ...f, start: { ...f.start, line: f.start.line + 40 } })),
  };
  assert.deepEqual(
    JSON.parse(gitlab(moved)).map((entry: { fingerprint: string }) => entry.fingerprint),
    JSON.parse(gitlab(REPORT)).map((entry: { fingerprint: string }) => entry.fingerprint),
  );
});

test("identical findings in one file get distinct fingerprints", () => {
  // Nine `unknown table: rejection_reasons` in one migration is a real shape. Hashing the triple
  // alone would collapse them into one entry in the widget.
  const twice: Report = {
    ...REPORT,
    findings: [
      finding("a.sql", 3, 0, "names/unknown-table", "warn", "unknown table: shipments"),
      finding("a.sql", 9, 0, "names/unknown-table", "warn", "unknown table: shipments"),
    ],
  };
  const [first, second] = JSON.parse(gitlab(twice));
  assert.notEqual(first.fingerprint, second.fingerprint);
});
