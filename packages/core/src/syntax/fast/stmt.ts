/**
 * What a statement declares: the tables and aliases in scope, and the query scopes inside it.
 *
 * This is the analysis half of statement parsing. The cursor half — locating what is being typed
 * and classifying the completion context — lives in `cursor.ts`. Splitting them keeps everything
 * the rules need in one file, and leaves the half that only an editor calls out of their way.
 */

import type { Dialect } from "../../dialects/dialect.ts";
import type { QueryScope, Relation } from "../../model/query.ts";
import type { Token, TokenRange } from "../types.ts";
import { kw, kwAny, matchingParen, punct, qualifiedName } from "./tok.ts";

/**
 * Reserved words that can follow a table name without being its alias.
 * Without this list, `FROM shipments WHERE ...` would record an alias called `WHERE`.
 */
const NOT_AN_ALIAS: ReadonlySet<string> = new Set([
  "WHERE",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "JOIN",
  "STRAIGHT_JOIN",
  "ON",
  "USING",
  "SET",
  "GROUP",
  "ORDER",
  "LIMIT",
  "HAVING",
  "UNION",
  "VALUES",
  "SELECT",
  "INTO",
  "FOR",
  "FORCE",
  "USE",
  "IGNORE",
  "PARTITION",
  "WINDOW",
  "DO",
  "THEN",
  "AND",
  "OR",
  "AS",
  "DUPLICATE",
  "ASC",
  "DESC",
]);

/** Words after which what you type is a table name. */
export const EXPECTS_TABLE: ReadonlySet<string> = new Set(["FROM", "JOIN", "UPDATE", "STRAIGHT_JOIN"]);

/** Modifiers that may sit between `INSERT`/`REPLACE` and the table it writes to. */
const INSERT_MODIFIERS: ReadonlySet<string> = new Set(["IGNORE", "LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY"]);

/** Verbs that open a query scope of their own. */
const QUERY_STARTERS: ReadonlySet<string> = new Set(["SELECT", "UPDATE", "DELETE", "INSERT", "REPLACE"]);

interface ReadRelation {
  relation: Relation | undefined;
  /** Where the walk resumes. */
  nextIdx: number;
  /** Whether it was a subquery, whose contents must still be walked. */
  derived: boolean;
}

/**
 * Reads a table reference: `name [[AS] alias]` or `(subquery) [[AS] alias]`.
 *
 * @param shallow Stop at a subquery instead of walking into it.
 */
function readRelation(tokens: readonly Token[], i: number, limit: number, shallow: boolean): ReadRelation {
  if (i > limit) return { relation: undefined, nextIdx: i, derived: false };

  // A subquery `(SELECT ...)` and a table function `JSON_TABLE(...)` are treated alike: they
  // contribute no catalog name, but they do contribute an alias that must resolve later.
  const here = tokens[i];
  let openIdx = -1;
  if (punct(here, "(")) openIdx = i;
  else if (here && here.t === "id" && punct(tokens[i + 1], "(")) openIdx = i + 1;

  if (openIdx !== -1) {
    // The alias is looked for after the closing paren, but the walk **descends** into the
    // subquery instead of skipping it: the relations it declares inside are what resolve its own
    // correlated references, and skipping them leaves a whole
    // `FROM (SELECT ... WHERE x = p.id ... FROM payments p)` without aliases.
    const closeIdx = matchingParen(tokens, openIdx);
    if (closeIdx === -1) return { relation: undefined, nextIdx: limit + 1, derived: false };

    // The subquery's range is kept: that is what later allows working out which columns it
    // produces, so a `t.*` pointing at it can be expanded.
    const relation: Relation = { offset: here!.s, derived: { from: openIdx, to: closeIdx } };
    let after = closeIdx + 1;
    if (kw(tokens[after], "AS")) after++;
    const aliasToken = tokens[after];
    if (aliasToken && aliasToken.t === "id" && !kwAny(aliasToken, NOT_AN_ALIAS)) {
      relation.alias = aliasToken.v;
      relation.aliasQuoted = aliasToken.q === true;
      after++;
    }

    // A shallow walk stops here: the subquery is a scope of its own, and the relations it
    // declares belong to it rather than to whoever contains it.
    if (shallow) return { relation, nextIdx: after, derived: false };

    return { relation, nextIdx: openIdx + 1, derived: true };
  }

  if (!here || here.t !== "id" || kwAny(here, NOT_AN_ALIAS)) {
    return { relation: undefined, nextIdx: i, derived: false };
  }

  const named = qualifiedName(tokens, i);
  const nameToken = named.nameToken!;
  const relation: Relation = {
    name: named.name,
    quoted: nameToken.q === true,
    schema: named.schema,
    offset: nameToken.s,
    nameSpan: { s: nameToken.s, e: nameToken.e },
  };
  i = named.nextIdx;

  if (kw(tokens[i], "AS")) i++;
  const aliasToken = tokens[i];
  if (aliasToken && aliasToken.t === "id" && !kwAny(aliasToken, NOT_AN_ALIAS)) {
    relation.alias = aliasToken.v;
    relation.aliasQuoted = aliasToken.q === true;
    i++;
  }

  return { relation, nextIdx: i, derived: false };
}

/**
 * Names a `WITH` clause defines in a token range, already folded.
 *
 * `WITH cte AS (SELECT ...) SELECT ... FROM cte` names a relation that exists only for the
 * length of the statement. Without this, the reference to it was reported as a table that is not
 * in the catalog — which is what the whole class of `unknown table: cte_x` was.
 *
 * The shape is demanded in full — `name [(columns)] AS (` — precisely so the other `WITH`s of
 * the language are not mistaken for one: `GROUP BY ... WITH ROLLUP` and
 * `START TRANSACTION WITH CONSISTENT SNAPSHOT` never reach the `AS (`.
 */
export function cteNames(
  dialect: Dialect,
  tokens: readonly Token[],
  from: number,
  to: number,
): Set<string> {
  const names = new Set<string>();
  let i = from;

  while (i <= to) {
    if (!kw(tokens[i], "WITH")) {
      i++;
      continue;
    }

    let j = i + 1;
    if (kw(tokens[j], "RECURSIVE")) j++;

    for (;;) {
      const nameToken = tokens[j];
      if (!nameToken || nameToken.t !== "id") break;

      let k = j + 1;
      // `WITH cte (a, b) AS (...)`: the explicit column list, which is skipped whole.
      if (punct(tokens[k], "(")) {
        const listClose = matchingParen(tokens, k);
        if (listClose === -1) break;
        k = listClose + 1;
      }

      if (!kw(tokens[k], "AS") || !punct(tokens[k + 1], "(")) break;
      const bodyClose = matchingParen(tokens, k + 1);
      if (bodyClose === -1) break;

      names.add(dialect.foldIdentifier(nameToken.v, nameToken.q === true));
      j = bodyClose + 1;
      // A `WITH` may define several, separated by commas.
      if (!punct(tokens[j], ",")) break;
      j++;
    }

    i = Math.max(j, i + 1);
  }

  return names;
}

/**
 * The row alias of an `INSERT … AS new ON DUPLICATE KEY UPDATE col = new.col`.
 *
 * MySQL 8.0.19 introduced it to replace the deprecated `VALUES()` function, and it is the only place
 * an `INSERT` declares a name of its own. Its columns **are** the target's — that is what the alias
 * means — so it comes back naming the same table, and `new.col` then gets checked against the real
 * definition rather than waved through as something unresolvable.
 *
 * `rowAlias` marks it because one consumer must not treat it as a second relation: the unqualified
 * `col` on the left of `ON DUPLICATE KEY UPDATE col = new.col` is the target's column and nothing
 * else, so pairing the two would manufacture an ambiguity MySQL does not have.
 *
 * **The alias is only read where `ON DUPLICATE` immediately follows it**, which is what separates it
 * from a select-list alias: `INSERT INTO t SELECT a AS b FROM u` writes the same two tokens, and
 * there the next word is `FROM` or a comma. Narrow on purpose — the shape this recognises is the one
 * the alias exists for.
 *
 * The column-alias form, `AS new(m, n)`, comes back **without** a name: those columns are positional
 * renames of the insert's own column list, and claiming they are the table's would be a guess. A
 * relation with no name is what the rest of the engine already reads as "columns nobody here can
 * assert", which is exactly the truth about it.
 */
function rowAlias(tokens: readonly Token[], from: number, to: number, table: string | undefined): Relation | undefined {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (punct(t, ";")) return undefined;
    else if (depth === 0 && kw(t, "AS")) {
      const aliasToken = tokens[i + 1];
      if (!aliasToken || aliasToken.t !== "id" || kwAny(aliasToken, NOT_AN_ALIAS)) continue;
      let after = i + 2;
      let columnList = false;
      if (punct(tokens[after], "(")) {
        const close = matchingParen(tokens, after);
        if (close === -1) return undefined;
        after = close + 1;
        columnList = true;
      }
      if (!kw(tokens[after], "ON") || !kw(tokens[after + 1], "DUPLICATE")) continue;
      return {
        name: columnList ? undefined : table,
        alias: aliasToken.v,
        aliasQuoted: aliasToken.q === true,
        rowAlias: true,
        offset: aliasToken.s,
      };
    }
  }
  return undefined;
}

/**
 * Gathers the tables and aliases declared in a token range.
 *
 * The whole statement is collected, including the part after the cursor: somebody completing in
 * the `SELECT` list needs the `FROM` tables they have not typed yet.
 *
 * @param shallow Collect only what the range declares at its own parenthesis depth.
 */
export function relations(
  dialect: Dialect,
  tokens: readonly Token[],
  from: number,
  to: number,
  shallow = false,
): Relation[] {
  const found: Relation[] = [];
  let i = from;
  let depth = 0;
  // Whether the range is worth a second pass looking for `WITH` names. Almost none are, and this
  // walk goes past every token anyway.
  let sawWith = false;

  while (i <= to) {
    const t = tokens[i];
    if (kw(t, "WITH")) sawWith = true;
    // `INSERT ... ON DUPLICATE KEY UPDATE Col = ...`: here `UPDATE` opens an assignment list
    // rather than a table, and reading `Col` as a table invented one that does not exist.
    const duplicateKeyUpdate = kw(t, "UPDATE") && kw(tokens[i - 1], "KEY");

    if (shallow && punct(t, "(")) {
      depth++;
      i++;
    } else if (shallow && punct(t, ")")) {
      depth--;
      i++;
    } else if (depth > 0) {
      i++;
    } else if (kwAny(t, EXPECTS_TABLE) && !duplicateKeyUpdate) {
      // `FROM a x, b y` is a list of references; a `JOIN` takes exactly one.
      const isList = kw(t, "FROM") || kw(t, "UPDATE");
      i++;
      for (;;) {
        const read = readRelation(tokens, i, to, shallow);
        if (read.relation) found.push(read.relation);
        // `readRelation` may consume nothing; advancing anyway avoids an infinite loop.
        i = read.nextIdx > i ? read.nextIdx : i + 1;
        // After a derived table the list ends: the walk is now inside the parenthesis, and the
        // commas in there belong to the subquery, not to the outer table list.
        if (read.derived || !(isList && read.relation && punct(tokens[i], ","))) break;
        i++;
      }
    } else if (kw(t, "INSERT") || kw(t, "REPLACE")) {
      i++;
      // `INSERT IGNORE INTO t`, `INSERT LOW_PRIORITY INTO t`: the modifiers sit between the verb
      // and the table. Skipping them is what makes the target a relation of the statement;
      // without it an `INSERT IGNORE` named no table at all, and every column of the one it
      // writes to came out as unknown.
      while (kwAny(tokens[i], INSERT_MODIFIERS)) i++;
      if (kw(tokens[i], "INTO")) i++;
      // `INSERT INTO t (cols) VALUES` — the target is just the name, never an alias of its own.
      const target = tokens[i];
      if (target && target.t === "id" && !kwAny(target, NOT_AN_ALIAS)) {
        const named = qualifiedName(tokens, i);
        const nameToken = named.nameToken!;
        found.push({
          name: named.name,
          quoted: nameToken.q === true,
          schema: named.schema,
          offset: nameToken.s,
          nameSpan: { s: nameToken.s, e: nameToken.e },
        });
        const row = rowAlias(tokens, named.nextIdx, to, named.name);
        if (row) found.push(row);
        i = named.nextIdx;
      }
    } else {
      i++;
    }
  }

  // A reference to a `WITH` of this same range is a relation, but not one the catalog holds.
  const ctes = sawWith ? cteNames(dialect, tokens, from, to) : undefined;
  if (ctes && ctes.size > 0) {
    for (const relation of found) {
      if (relation.name && !relation.schema && ctes.has(dialect.foldIdentifier(relation.name, relation.quoted === true))) {
        relation.cte = true;
      }
    }
  }

  return found;
}

/**
 * Bounds of the statement containing `offset`.
 *
 * It only cuts at `;` and `BEGIN`. It is tempting to also cut at `THEN`, `ELSE` or `END` for a
 * tighter fit, but those three words also appear inside `CASE ... WHEN ... THEN ... END`
 * expressions, and cutting there would leave a `SELECT` without its own `FROM`.
 */
export function statementBounds(tokens: readonly Token[], offset: number): TokenRange {
  let from = 0;
  let to = tokens.length - 1;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.e <= offset && (punct(t, ";") || kw(t, "BEGIN"))) {
      from = i + 1;
      break;
    }
  }

  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.s >= offset && punct(t, ";")) {
      to = i - 1;
      break;
    }
  }

  return { from, to: Math.max(to, from - 1) };
}

/**
 * Splits the whole stream into statements, cutting on the same rule as `statementBounds`.
 *
 * The diagnostics use it: they walk the entire file and cannot call the per-position analysis
 * for every token without going quadratic.
 */
export function statements(tokens: readonly Token[]): TokenRange[] {
  const list: TokenRange[] = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (punct(tokens[i], ";") || kw(tokens[i], "BEGIN")) {
      if (i > start) list.push({ from: start, to: i - 1 });
      start = i + 1;
    }
  }
  if (start <= tokens.length - 1) list.push({ from: start, to: tokens.length - 1 });
  return list;
}

/**
 * Splits the stream into **query scopes**: one per `SELECT`, `UPDATE`, `DELETE`, `INSERT` or
 * `REPLACE`, nested through the parentheses.
 *
 * `statements` cuts on `;` and `BEGIN`, which is the right bound for most of the rules and the
 * wrong one for anything that asks "what does this name resolve to". Two reasons:
 *
 *   - `IF EXISTS(SELECT ... FROM A) THEN UPDATE B ...;` has no `;` until the end, so two queries
 *     arrive as one statement and A and B look like they are joined.
 *   - `INSERT INTO aud_X SELECT ... FROM X` names two relations, but the target is not in the
 *     `SELECT`'s scope: MySQL resolves the list against `X` alone.
 *
 * Both are fixed by the same cut. A scope ends at the `)` that closes the parenthesis it was
 * opened inside, at a `;`, or where a sibling at its own depth begins — which is what makes
 * `SELECT ... UNION SELECT ...` two scopes rather than one.
 *
 * @returns In source order, so a nested scope always follows its parent.
 */
export function queryScopes(tokens: readonly Token[]): QueryScope[] {
  const scopes: QueryScope[] = [];
  const stack: QueryScope[] = [];
  let depth = 0;

  /** Closes every open scope at `minDepth` or deeper. */
  const close = (minDepth: number, at: number): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= minDepth) {
      stack.pop()!.to = at;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) {
      depth++;
    } else if (punct(t, ")")) {
      close(depth, i - 1);
      depth--;
    } else if (punct(t, ";")) {
      close(0, i - 1);
    } else if (kwAny(t, QUERY_STARTERS) && !(kw(t, "UPDATE") && kw(tokens[i - 1], "KEY"))) {
      close(depth, i - 1);
      const scope: QueryScope = { from: i, to: tokens.length - 1, depth, parent: stack[stack.length - 1] };
      stack.push(scope);
      scopes.push(scope);
    }
  }
  close(0, tokens.length - 1);

  return scopes;
}
