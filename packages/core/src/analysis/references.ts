/**
 * Finding every use of a name across a project.
 *
 * This is the question that comes before any schema change — "who reads this column?", "which
 * procedures touch this table?" — and the one thing the catalog alone cannot answer, because it
 * deliberately never parses routine bodies.
 *
 * The module does no I/O and knows nothing about the protocol: the caller supplies each file's
 * text. That keeps the reading, and its cache, wherever the caller already does its reading.
 *
 * ## Why it is not a substring search
 *
 * On a real schema, searching a table called `orders` by substring also returns `aud_orders`,
 * `LogOrders` and `OrdersMig`, which are different tables — and on a central name they outnumber
 * the real hits. Matching whole identifier tokens is not a refinement of a grep, it is the
 * difference between an answer and a list to read by hand.
 *
 * Lexing is only paid by the files a plain substring test has already accepted, which on a
 * repository of a few thousand files takes the scan from every file down to a few hundred.
 */

import { tokenize } from "../syntax/fast/lexer.ts";
import { punct } from "../syntax/fast/tok.ts";
import type { Span } from "../syntax/types.ts";
import { OwnerSource } from "./owners.ts";
import type { ResolveContext } from "./resolve.ts";

export interface RefTarget {
  /** The identifier being looked for. */
  name: string;
  /** Owning table, when the name is a column. */
  owner?: string;
  /** Whether that table really carries it. */
  ownerHasColumn?: boolean;
}

export interface Reference extends Span {
  /** Whether it was written `alias.Name`. */
  qualified: boolean;
  /** Whether it was written delimited, which a rename has to preserve. */
  quoted: boolean;
}

/** One file handed to the scan, and what came back out of it. */
export interface FileSource {
  path: string;
  src: string;
}

export interface FileReferences extends FileSource {
  refs: Reference[];
}

/**
 * Could this source mention the name at all?
 *
 * The cheap gate in front of the lexer. It is a substring test on purpose: it must never reject a
 * file that does contain the token, and refining it here would only duplicate what the lexer does
 * properly two steps later.
 *
 * Both arguments are already lower-cased by the caller, and with `toLowerCase` rather than the
 * dialect's folding: this is a test on text, not a name lookup, and a dialect that folded more
 * narrowly would turn the gate into a filter that drops real hits.
 *
 * @param lowered The source, lower-cased.
 * @param needle The name, lower-cased.
 */
export function mentions(lowered: string, needle: string): boolean {
  return lowered.includes(needle);
}

/**
 * Every occurrence of the name in one source, as whole identifiers.
 *
 * With `target.owner` set the name is treated as a column of that table, and the hits are narrowed
 * to the ones that really refer to **its** column. That is `columnOwners`' question — whose column
 * is this token — asked of every token that spells the name, so the answer is the one the editor and
 * the diagnostics give rather than a second opinion:
 *
 *   - `o.status` counts when `o` resolves to the owning table where it is written: an alias of it, a
 *     `NEW`/`OLD` in a trigger on it, or its own name — and not when a temporary table, a `WITH`
 *     name or a derived table of that name stands in the way.
 *   - a bare `status` counts when the innermost query that has a column of that name has it from the
 *     owning table. The same word in the other half of a join, in a subquery over another table, on
 *     the `SELECT` side of an `INSERT … SELECT`, as a local of the same name or as an output alias is
 *     somebody else's.
 *   - inside a `CREATE TABLE`, an `ALTER TABLE` or a `CREATE INDEX` every bare name is the table's
 *     own, except the list after `REFERENCES u`, which is `u`'s. The declaration is part of the
 *     answer: it is the one place a column is defined rather than used, and a rename that skipped
 *     it would leave the schema disagreeing with its own queries.
 *
 * A bare use also needs `ownerHasColumn`. Asking for a column its table does not have — `orders.status`,
 * when the column is on `customers` — would otherwise return every bare `status` in `orders`' own
 * DDL, where every name is the table's, which is a wrong answer rather than a broad one. Qualified
 * uses do not need it: somebody writing `o.status` means that column whether or not it exists.
 *
 * Owners are compared by the table's folded name, because the catalog's tables are whatever the
 * files defined and the owner arrives as the text the caller read out of one.
 */
export function find(ctx: ResolveContext, src: string, target: RefTarget): Reference[] {
  const lexed = tokenize(src);
  const tokens = lexed.tokens;
  const fold = (name: string, quoted = false): string => ctx.dialect.foldIdentifier(name, quoted);
  const needle = fold(target.name);
  const out: Reference[] = [];

  /** Records a token, noting whether it was written `something.Name`. */
  const keep = (i: number): void => {
    const t = tokens[i]!;
    out.push({ s: t.s, e: t.e, qualified: punct(tokens[i - 1], "."), quoted: t.q === true });
  };

  const isNeedle = (i: number): boolean => {
    const t = tokens[i];
    return t !== undefined && t.t === "id" && fold(t.v, t.q === true) === needle;
  };

  if (target.owner === undefined) {
    for (let i = 0; i < tokens.length; i++) if (isNeedle(i)) keep(i);
    return out;
  }

  const owner = fold(target.owner);
  const source = new OwnerSource(ctx, src, lexed);
  for (let i = 0; i < tokens.length; i++) {
    if (!isNeedle(i)) continue;
    if (!punct(tokens[i - 1], ".") && !target.ownerHasColumn) continue;
    const owners = source.columnOwners(i);
    if (owners?.some((table) => fold(table.name) === owner)) keep(i);
  }

  return out;
}

/**
 * Runs the two stages over a set of files.
 *
 * `sources` is walked lazily, so the caller decides whether a file's text comes from a cache, from
 * disk or from an open buffer. The source is handed back with the hits so the caller does not read
 * the file twice: turning an offset into a line and a column needs the same text the scan just had.
 */
export function scan(
  ctx: ResolveContext,
  sources: Iterable<FileSource>,
  target: RefTarget,
): FileReferences[] {
  const needle = target.name.toLowerCase();
  const owner = target.owner?.toLowerCase();
  const found: FileReferences[] = [];

  for (const { path, src } of sources) {
    const lowered = src.toLowerCase();
    // A file using a column has to name its table somewhere too, so both gates are applied before
    // anything is lexed.
    if (!mentions(lowered, needle)) continue;
    if (owner !== undefined && !mentions(lowered, owner)) continue;

    const refs = find(ctx, src, target);
    if (refs.length > 0) found.push({ path, src, refs });
  }

  return found;
}
