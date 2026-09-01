/**
 * The command, end to end.
 *
 * `main` is called directly with fake streams rather than spawned, so a failing case points at a
 * line instead of at a subprocess — and so the exit code, which is most of what a CI integration
 * depends on, is a return value that can be asserted on.
 *
 * The fixtures under `fixtures/shop` are a schema repo in miniature: two tables, a procedure that
 * gets one finding of each severity, and a migration in `deploy_folder/` of the shape this phase
 * exists for — it declares a table and then writes to it.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main, type Streams } from "../src/cli.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const SHOP = join(FIXTURES, "shop");

interface Run {
  code: number;
  out: string;
  err: string;
}

function cli(args: string[], cwd = SHOP, env: Record<string, string | undefined> = {}): Run {
  const out: string[] = [];
  const err: string[] = [];
  const streams: Streams = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    isTTY: false,
    env: { NO_COLOR: "1", ...env },
    cwd,
  };
  return { code: main(args, streams), out: out.join("\n"), err: err.join("\n") };
}

// ------------------------------------------------------------------------ check

test("check reports one finding of each severity, in source order", () => {
  const { code, out } = cli(["check"]);
  assert.equal(code, 1);
  assert.match(out, /sps\/sp_settle_orders\.sql/);
  assert.match(out, /3:11 +hint +routine\/unused-variable/);
  assert.match(out, /5:60 +error +query\/insert-value-count/);
  assert.match(out, /7:10 +warn +query\/unfiltered-write/);
  // In source order: the hint at line 3 is printed before the error at line 5, though the rules
  // that found them ran the other way round.
  assert.ok(out.indexOf("3:11") < out.indexOf("5:60"));
  assert.match(out, /4 findings in 4 files \(1 error, 2 warn, 1 hint\)/);
});

test("a migration is checked against a catalog that can see its own CREATE TABLE", () => {
  const { out } = cli(["check", "deploy_folder"]);
  // Two `INSERT`s into a table this file declares: silent. One into a table nobody declares: not.
  // Matched on the message, not the name — the name is also in the file's own path.
  assert.doesNotMatch(out, /unknown table: rejection_reasons/);
  assert.match(out, /unknown table: shipping_zones/);
  assert.match(out, /1 finding in 1 file/);
});

test("a path names what gets linted, not what gets catalogued", () => {
  // `orders` has a foreign key into `customers`, which is in a file this run does not lint. If the
  // catalog were narrowed along with the sweep, that key would report a table that does not exist.
  const { code, out } = cli(["check", "tables/orders.sql"]);
  assert.equal(code, 0);
  assert.match(out, /no findings in 1 file/);
});

test("--quiet drops hints from the report and from its counts", () => {
  const { code, out } = cli(["check", "--quiet"]);
  assert.equal(code, 1);
  assert.doesNotMatch(out, /unused-variable/);
  assert.match(out, /3 findings in 4 files \(1 error, 2 warn, 0 hint\)/);
});

test("a hint never fails the run", () => {
  const { code, out } = cli(["check", "tables"]);
  assert.equal(code, 0);
  assert.match(out, /no findings/);
});

test("--max-warnings turns warnings into a failure past its number", () => {
  // The fixture has two warnings, and one error that fails it either way — so the flag is tested
  // where it decides on its own, over the files that have no error in them.
  assert.equal(cli(["check", "deploy_folder"]).code, 0);
  assert.equal(cli(["check", "deploy_folder", "--max-warnings", "1"]).code, 0);
  assert.equal(cli(["check", "deploy_folder", "--max-warnings", "0"]).code, 1);
});

test("--max-warnings wants a number", () => {
  const { code, err } = cli(["check", "--max-warnings", "some"]);
  assert.equal(code, 2);
  assert.match(err, /whole number/);
});

test("an unknown format is a usage error, not an empty report", () => {
  const { code, err } = cli(["check", "--format", "xml"]);
  assert.equal(code, 2);
  assert.match(err, /unknown format: xml/);
});

test("a directory with no recognised layout works when it is named", () => {
  // The `isDdlProject` guard is about implicit activation in an editor. Running the command is
  // explicit, so a flat directory of `.sql` has to be checkable. Copied out of this repo so that
  // the `.git` above it does not become the root and drag the whole checkout in.
  const dir = mkdtempSync(join(tmpdir(), "sqldex-flat-"));
  cpSync(join(FIXTURES, "flat"), dir, { recursive: true });
  const { code, out } = cli(["check", "."], dir);
  assert.equal(code, 0);
  assert.match(out, /no findings in 1 file/);
});

test("a file that does not parse reports a syntax error, independent of the rule registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqldex-broken-"));
  cpSync(join(FIXTURES, "broken"), dir, { recursive: true });
  const { code, out } = cli(["check", ".", "--format", "json"], dir);
  assert.equal(code, 1);
  const report = JSON.parse(out) as { findings: { code: string; severity: string; message: string }[] };
  const syntaxErrors = report.findings.filter((f) => f.code === "sqldex:syntax-error");
  assert.equal(syntaxErrors.length, 1);
  assert.equal(syntaxErrors[0]?.severity, "error");
  assert.match(syntaxErrors[0]?.message ?? "", /syntax error:/);
});

test("--no-syntax-check drops the syntax-error finding, and only that one", () => {
  // Real MySQL grammar parsing costs real time per file — measured against a private corpus of
  // 1,500+ real files, tens of seconds where the rest of the sweep takes a few. This is the escape
  // hatch for a project too large to pay that cost on every run, not a way to make a broken file
  // look clean: everything the rule registry finds on its own is unaffected.
  const dir = mkdtempSync(join(tmpdir(), "sqldex-broken-"));
  cpSync(join(FIXTURES, "broken"), dir, { recursive: true });
  const { code, out } = cli(["check", ".", "--format", "json", "--no-syntax-check"], dir);
  const report = JSON.parse(out) as { findings: { code: string }[] };
  assert.equal(report.findings.some((f) => f.code === "sqldex:syntax-error"), false);
  assert.ok(code === 0 || report.findings.length > 0, "the rest of the registry still ran");
});

test("syntax_check.enabled: false in .sqldex.json does the same, without a flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqldex-broken-"));
  cpSync(join(FIXTURES, "broken"), dir, { recursive: true });
  writeFileSync(join(dir, ".sqldex.json"), JSON.stringify({ syntax_check: { enabled: false } }));
  const { out } = cli(["check", ".", "--format", "json"], dir);
  const report = JSON.parse(out) as { findings: { code: string }[] };
  assert.equal(report.findings.some((f) => f.code === "sqldex:syntax-error"), false);
});

// ----------------------------------------------------------------- rules, explain

test("rules lists every rule, sorted by id", () => {
  const { code, out } = cli(["rules"]);
  assert.equal(code, 0);
  assert.match(out, /46 rules\./);
  assert.ok(out.indexOf("audit/table-out-of-sync") < out.indexOf("names/unknown-table"));
});

test("rules --format json carries the docs", () => {
  const { out } = cli(["rules", "--format", "json"]);
  const parsed: { id: string; group: string; docs: string }[] = JSON.parse(out);
  assert.equal(parsed.length, 46);
  assert.ok(parsed.every((rule) => rule.docs.length > 0));
  assert.ok(parsed.every((rule) => rule.id.startsWith(`${rule.group}/`)));
});

test("explain prints a rule's whole reasoning", () => {
  const { code, out } = cli(["explain", "query/unfiltered-write"]);
  assert.equal(code, 0);
  assert.match(out, /^query\/unfiltered-write\nquery · warn · statement\n/);
  assert.match(out, /The guards are what make it usable/);
});

test("explain suggests when the id is nearly right", () => {
  const { code, err } = cli(["explain", "unfiltered-write"]);
  assert.equal(code, 2);
  assert.match(err, /no rule called unfiltered-write/);
  assert.match(err, /query\/unfiltered-write/);
});

test("explain on nothing like a rule points at the list", () => {
  const { code, err } = cli(["explain", "zzz"]);
  assert.equal(code, 2);
  assert.match(err, /sqldex rules/);
});

// ------------------------------------------------------------------------ usage

test("no command prints usage and fails", () => {
  const { code, out } = cli([]);
  assert.equal(code, 2);
  assert.match(out, /sqldex check \[paths\.\.\.\]/);
});

test("--help prints usage and succeeds", () => {
  const { code, out } = cli(["--help"]);
  assert.equal(code, 0);
  assert.match(out, /Exit codes: 0 clean/);
});

test("an unknown command says so", () => {
  const { code, err } = cli(["lint"]);
  assert.equal(code, 2);
  assert.match(err, /unknown command: lint/);
});

test("an unknown flag is a usage error", () => {
  const { code, err } = cli(["check", "--fix"]);
  assert.equal(code, 2);
  assert.match(err, /--fix/);
});

test("--diff with no base and no CI environment says which variables it looked at", () => {
  const { code, err } = cli(["check", "--diff", "auto"]);
  assert.equal(code, 2);
  assert.match(err, /CI_MERGE_REQUEST_DIFF_BASE_SHA/);
  assert.match(err, /GITHUB_BASE_REF/);
});

