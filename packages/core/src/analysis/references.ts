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

import type { Dialect } from "../dialects/dialect.ts";
import { tokenize } from "../syntax/fast/lexer.ts";
import { relations, statements } from "../syntax/fast/stmt.ts";
import { punct } from "../syntax/fast/tok.ts";
import type { Span } from "../syntax/types.ts";

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
 * to the ones that really refer to **its** column:
 *
 *   - `o.status` counts only when `o` names or aliases the owning table in that statement.
 *   - a bare `status` counts only when the statement involves the owning table **and** that table
 *     actually has the column.
 *
 * The second half of that last condition is not belt and braces. Asking for a column its table
 * does not have — `orders.status`, when the column is on `customers` — otherwise returns every
 * bare `status` of every other table joined alongside it, which is a wrong answer rather than a
 * broad one.
 */
export function find(dialect: Dialect, src: string, target: RefTarget): Reference[] {
  const tokens = tokenize(src).tokens;
  const fold = (name: string, quoted = false): string => dialect.foldIdentifier(name, quoted);
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
  for (const statement of statements(tokens)) {
    // Which names stand for the owning table inside this statement.
    const aliases = new Set<string>();
    let involves = false;
    for (const item of relations(dialect, tokens, statement.from, statement.to)) {
      if (item.name === undefined || fold(item.name, item.quoted === true) !== owner) continue;
      involves = true;
      aliases.add(
        item.alias === undefined
          ? fold(item.name, item.quoted === true)
          : fold(item.alias, item.aliasQuoted === true),
      );
    }
    if (!involves) continue;

    for (let i = statement.from; i <= statement.to; i++) {
      if (!isNeedle(i)) continue;
      const qualifier = punct(tokens[i - 1], ".") ? tokens[i - 2] : undefined;
      if (qualifier !== undefined && qualifier.t === "id") {
        if (aliases.has(fold(qualifier.v, qualifier.q === true))) keep(i);
      } else if (target.ownerHasColumn) {
        keep(i);
      }
    }
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
  dialect: Dialect,
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

    const refs = find(dialect, src, target);
    if (refs.length > 0) found.push({ path, src, refs });
  }

  return found;
}
