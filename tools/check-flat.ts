/**
 * The layout ↔ `auto` check: a repo with no recognised convention must not get a smaller catalog.
 *
 *     node tools/check-flat.ts <repo>...
 *
 * The tempting invariant is the stronger one — that a source's `kind` changes only how much work
 * is done, never what is found — and **that is not true**, which this check is how we found out.
 * A routines directory can hold plain, non-temporary `CREATE TABLE` statements *inside* the
 * procedures: backup copies of tables already declared under `tables/`, and scratch tables that
 * exist nowhere else. Declaring that directory as `routines` skips the table parser there, so the
 * layout catalog does not see them and a flat sweep does.
 *
 * That difference is not a bug and should not be closed. Declaring a directory as routines *is*
 * saying "what gets defined in here is not schema" — the same judgment that keeps a deploy folder
 * out. Closing it would also make a procedure's stale copy of a table win over the real
 * declaration, purely because `sps` sorts after `tables`.
 *
 * So the property actually worth holding down is the one that protects the user with no
 * convention: **`auto` never finds less.** A repo swept flat may catalogue more than a typed
 * layout would — it has no convention telling it what to ignore — but never fewer names, and any
 * name it files against a different definition has to show up in the duplicate report rather than
 * silently replacing one.
 *
 * The check holds the **file list fixed** and varies only the kind, which is what isolates the
 * question. Comparing a flat glob against the detected layout would also fold in the deploy
 * folder, a difference that is about the file list and not about the kind.
 *
 * It also reports what the prefilter costs, since that is the whole reason `auto` is affordable.
 */

import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";

import { Catalog } from "../packages/core/src/catalog/catalog.ts";
import { sourceFiles } from "../packages/core/src/catalog/project.ts";
import { mysql } from "../packages/core/src/dialects/mysql/index.ts";

/**
 * Everything about a catalog that the kind must not change, keyed by the name it is filed under.
 *
 * Keyed rather than listed, because a single extra table shifts every sorted line after it and a
 * positional diff would report thousands of differences for one.
 */
function fingerprint(catalog: Catalog, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const rel = (path: string): string => relative(root, path);

  for (const [key, table] of catalog.tables) {
    out.set(`T ${key}`, `${rel(table.file!)} ${table.columns.map((c) => c.name).join(",")}`);
  }
  for (const [key, routine] of catalog.routines) out.set(`R ${key}`, `${rel(routine.file!)} ${routine.signature}`);
  for (const [key, trigger] of catalog.triggers) out.set(`G ${key}`, `${rel(trigger.file!)} ${trigger.table}`);
  for (const [key, temp] of catalog.tempTables) out.set(`X ${key}`, rel(temp.file));
  return out;
}

/**
 * What the prefilter saves: the naive form that also tests for `CREATE DEFINER`, against the one
 * in use, over the same files.
 */
function prefilterCost(files: readonly { path: string }[]): { naive: number; now: number } {
  let naive = 0;
  let now = 0;
  for (const file of files) {
    const src = readFileSync(file.path, "utf8");
    if (
      src.includes("CREATE TABLE") ||
      src.includes("create table") ||
      src.includes("CREATE TRIGGER") ||
      src.includes("CREATE DEFINER")
    ) {
      naive++;
    }
    if (/(create[ \t\n\v\f\r]+table)|trigger/i.test(src)) now++;
  }
  return { naive, now };
}

function check(root: string): boolean {
  const files = sourceFiles(root);
  const layout = Catalog.build(mysql, root);
  const flat = Catalog.of(
    mysql,
    root,
    files.map((file) => ({ path: file.path, kind: "auto" as const })),
  );

  // `tempTables` fills in lazily and both sides must be asked the same questions.
  for (const key of layout.tempTables.keys()) layout.tempTable(key);
  for (const key of flat.tempTables.keys()) flat.tempTable(key);

  const a = fingerprint(layout, root);
  const b = fingerprint(flat, root);

  /** A name the layout catalogued and the flat sweep did not: the failure this check exists for. */
  const missing: string[] = [];
  /** A name filed against a different definition. Allowed, but it has to be reported as a duplicate. */
  const rebound: string[] = [];
  /** A name only the flat sweep found, which is legitimate and worth seeing. */
  const extra: string[] = [];

  const duplicated = new Set(flat.stats.duplicates.map((d) => d.name.toLowerCase()));
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (x === y) continue;
    const line = `  ${key}\n    layout: ${x ?? "(absent)"}\n    auto  : ${y ?? "(absent)"}`;
    if (y === undefined) missing.push(line);
    else if (x === undefined) extra.push(line);
    else if (duplicated.has(key.slice(2))) rebound.push(line);
    else missing.push(`${line}\n    (rebound with no duplicate reported)`);
  }

  const cost = prefilterCost(files);
  const verdict = missing.length === 0 ? "OK" : `${missing.length} MISSING`;
  const notes = [
    extra.length > 0 ? `+${extra.length} only in auto` : "",
    rebound.length > 0 ? `${rebound.length} rebound (reported as duplicates)` : "",
  ].filter(Boolean);
  console.log(
    `${basename(root).padEnd(12)} ${String(files.length).padStart(5)} files  ` +
      `${String(a.size).padStart(5)} names  ${verdict}` +
      (notes.length > 0 ? `  (${notes.join(", ")})` : "") +
      `  prefilter: ${cost.now}/${files.length} lexed (${cost.naive} with CREATE DEFINER)`,
  );
  for (const line of [...missing, ...extra, ...rebound].slice(0, 8)) console.log(line);

  return missing.length === 0;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: node tools/check-flat.ts <repo>...");
  process.exit(2);
}

let allOk = true;
for (const root of roots) allOk = check(root) && allOk;

console.log(allOk ? "\nlayout ↔ auto: auto loses nothing" : "\nlayout ↔ auto: auto LOSES names");
process.exit(allOk ? 0 : 1);
