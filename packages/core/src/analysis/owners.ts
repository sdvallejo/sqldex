/**
 * Whose column is this token?
 *
 * One question, asked by two callers who had better agree: find-references, sweeping a project for
 * the uses of `orders.customer_id`, and the editor, deciding what the cursor is on. Answering it
 * twice — once by "the statement involves the table", once by "the first relation that has it" — is
 * how a search for one table's column came back full of another's. So both ask here.
 *
 * ## What decides it
 *
 *   - **A qualified name** is the qualifier's: the innermost query scope that declares it, the
 *     statement's own aliases failing that, then the catalog by name. `NEW`/`OLD` are the trigger's
 *     table, and a temporary table, a `WITH` name or a derived table of that name shadows a
 *     catalog table — none of which is a catalog table's column.
 *   - **A bare name in a query** is the column of the **innermost** scope whose relations have it,
 *     and never of one further out: that is what MySQL does, and it is what keeps a correlated
 *     subquery's own `customer_id` from being credited to the table it is correlated with.
 *   - **A bare name in DDL** is the column of the table being created or altered, read from the
 *     tokens rather than from the model — which is what reaches a `CHECK`, a generated column, an
 *     `ALTER TABLE` and a `CREATE INDEX`, none of which the model stores. The one exception is the
 *     list after `REFERENCES u`, which is `u`'s.
 *
 * What a bare name is *not*: a local or parameter of the enclosing body, a table, a routine, a
 * temporary table, a name the `SELECT` list itself defines, or — in `GROUP BY` / `ORDER BY` /
 * `HAVING` — an output name some alias gave. Each of those is a word that happens to be spelled
 * like a column.
 */

import { isKeyword } from "../dialects/mysql/index.ts";
import type { Locals } from "../model/locals.ts";
import type { Relation } from "../model/query.ts";
import type { Table } from "../model/table.ts";
import type { ScopeInfo } from "../rules/rule.ts";
import { parseDDL } from "../syntax/fast/ddl.ts";
import { parseRoutines } from "../syntax/fast/routine.ts";
import { relations as statementRelations, statements } from "../syntax/fast/stmt.ts";
import { kw, matchingParen, objectAfterCreate, punct, qualifiedName } from "../syntax/fast/tok.ts";
import type { Lexed, Token, TokenRange } from "../syntax/types.ts";
import { collect, selectListColumns } from "./locals.ts";
import {
  columnNames,
  foreignSchema,
  qualifierIn,
  relation as resolveRelation,
  type ResolveContext,
} from "./resolve.ts";
import { buildScopes, routineBodies, triggerBodies, type BodyScope } from "./scopes.ts";

/** Is this identifier inside a `USE INDEX (...)` / `FORCE KEY (...)` hint, where names are indexes? */
function inIndexHint(tokens: readonly Token[], i: number): boolean {
  let j = i - 1;
  while (tokens[j] && (tokens[j]!.t === "id" || punct(tokens[j], ","))) j--;
  if (!punct(tokens[j], "(")) return false;

  for (let k = j - 1; k >= Math.max(j - 5, 0); k--) {
    if (kw(tokens[k], "INDEX") || kw(tokens[k], "KEY")) {
      const before = tokens[k - 1];
      return kw(before, "USE") || kw(before, "FORCE") || kw(before, "IGNORE");
    }
  }
  return false;
}

/**
 * Could this identifier be an unqualified column?
 *
 * Shared deliberately: the rule that asks whether a bare name exists and the rule that asks whether
 * it is ambiguous both start from this question, and they had better answer it identically. Two
 * copies of this predicate would drift, and the drift would show up as one rule contradicting the
 * other about the same token.
 *
 * The exclusions are each a class of name that is not a column at all:
 *
 *   - part of a qualified name, which is checked elsewhere with more to go on;
 *   - a function call, given away by the `(` that follows;
 *   - a block label, `retry: BEGIN` where it is declared and `LEAVE retry` where it is used;
 *   - a collation or character set — `x COLLATE utf8mb4_unicode_ci`, `CONVERT(x USING latin1)` —
 *     which name something of the server's rather than of the schema. A join's `USING` never
 *     reaches here, because MySQL demands a parenthesis after it;
 *   - an index named in an optimiser hint;
 *   - a session variable, which starts with `@`;
 *   - a reserved word, unless it was written delimited, which is what saying so means.
 *
 * @param keywords Accept a language word too. A rule has to refuse `status` because it cannot know
 * whether it is a column; a search for a name the catalog already says **is** one does know, and
 * `status` and `comment` are exactly the words people name columns.
 */
export function bareColumnCandidate(tokens: readonly Token[], i: number, keywords = false): boolean {
  const token = tokens[i];
  if (!token || token.t !== "id") return false;
  return (
    !punct(tokens[i - 1], ".") &&
    !punct(tokens[i + 1], ".") &&
    !punct(tokens[i + 1], "(") &&
    !punct(tokens[i + 1], ":") &&
    !kw(tokens[i - 1], "LEAVE") &&
    !kw(tokens[i - 1], "ITERATE") &&
    !kw(tokens[i - 1], "COLLATE") &&
    !kw(tokens[i - 1], "USING") &&
    !inIndexHint(tokens, i) &&
    !token.v.startsWith("@") &&
    (keywords || token.q === true || !isKeyword(token.v))
  );
}

/** One relation of a scope that has a column, by the name the query calls it. */
export interface Holder {
  /** The alias, or the name when there is none. */
  label: string;
  /** The catalog table behind it, when it is one; a temporary or derived table has none. */
  table?: Table;
}

/** What a scope resolves a bare name against, worked out once per scope. */
export interface Described {
  /** Which relations hold each name — the names, not a count. */
  holders: Map<string, Holder[]>;
  /** Names a `USING (...)` merged into one column, so they are no longer ambiguous. */
  merged: Set<string>;
  /** A `NATURAL JOIN` merges every shared name, without saying which. */
  natural: boolean;
  /** Names the `SELECT` list produces. */
  output: Set<string>;
  /** The part of `output` an alias named, which is not the column the alias is written beside. */
  aliased: Set<string>;
  /** Token indexes where the list *defines* a name rather than reading a column. */
  defines: Set<number>;
  /** Where `GROUP BY` / `ORDER BY` / `HAVING` begins, past which the output names are visible. */
  tail: number;
}

/**
 * @param derived Also read the columns of a derived table from its own `SELECT`, and tell the names
 * an alias gave apart from the rest. The ambiguity rule has never done either, and doing it there
 * would change what it reports; a search for a column's uses needs both, because a name that lives
 * in a subquery's output is not the column of the table the subquery read it from.
 */
export function describe(
  ctx: ResolveContext,
  locals: Locals,
  tokens: readonly Token[],
  scope: ScopeInfo,
  derived = false,
): Described {
  const { dialect } = ctx;
  const fold = (name: string): string => dialect.foldIdentifier(name, false);

  const holders = new Map<string, Holder[]>();
  for (const relation of scope.relations) {
    // The row alias of an `INSERT … ON DUPLICATE KEY UPDATE` names the same columns as the target it
    // sits beside, so counting both would make every assignment in the clause look ambiguous. MySQL
    // reads the bare name there as the table's, always.
    if (relation.rowAlias) continue;
    const label = relation.alias ?? relation.name;
    if (!label) continue;
    const resolved = resolveRelation(ctx, locals, relation, derived ? tokens : undefined);
    const holder: Holder = resolved?.table ? { label, table: resolved.table } : { label };
    for (const name of columnNames(resolved)) {
      const key = fold(name);
      const list = holders.get(key);
      if (list) list.push(holder);
      else holders.set(key, [holder]);
    }
  }

  const merged = new Set<string>();
  let natural = false;
  let depth = 0;
  for (let i = scope.from; i <= scope.to; i++) {
    const t = tokens[i]!;
    if (punct(t, "(")) depth++;
    else if (punct(t, ")")) depth--;
    else if (depth === 0 && kw(t, "NATURAL")) natural = true;
    else if (depth === 0 && kw(t, "USING") && punct(tokens[i + 1], "(")) {
      const close = matchingParen(tokens, i + 1);
      for (let j = i + 2; j <= (close === -1 ? i + 1 : close) - 1; j++) {
        if (tokens[j]!.t === "id") merged.add(fold(tokens[j]!.v));
      }
    }
  }

  const output = new Set<string>();
  const aliased = new Set<string>();
  let defines = new Set<number>();
  let tail = Number.POSITIVE_INFINITY;
  if (kw(tokens[scope.from], "SELECT")) {
    const list = selectListColumns(tokens, scope.from, scope.to);
    for (const name of list.names) output.add(fold(name));
    defines = list.definedAt;
    if (derived) {
      for (const name of selectListColumns(tokens, scope.from, scope.to, true).names) aliased.add(fold(name));
    }

    depth = 0;
    for (let i = scope.from; i <= scope.to; i++) {
      const t = tokens[i]!;
      if (punct(t, "(")) depth++;
      else if (punct(t, ")")) depth--;
      else if (depth === 0 && (kw(t, "GROUP") || kw(t, "ORDER") || kw(t, "HAVING"))) {
        tail = i;
        break;
      }
    }
  }

  return { holders, merged, natural, output, aliased, defines, tail };
}

/** What a `CREATE TABLE`, `ALTER TABLE` or `CREATE INDEX` says about whose its names are. */
interface DdlInfo {
  /** The table being created or altered; absent for a temporary or an unknown one. */
  table?: Table;
  /** Where the DDL part ends: a `CREATE TABLE … SELECT` is DDL up to the `SELECT` and a query after. */
  to: number;
  /** Token indexes of the names of things — tables, constraints, indexes — which are not columns. */
  skip: Set<number>;
  /** The lists after `REFERENCES u`, which belong to `u`. */
  references: { from: number; to: number; table: Table | undefined }[];
}

/** The clause words whose next identifier names a constraint or an index, not a column. */
const NAMES_A_THING = ["CONSTRAINT", "INDEX", "KEY", "REFERENCES"];

/**
 * One source, asked about token by token.
 *
 * Built once per file and filled in on demand: a sweep lexes thousands of files and asks about the
 * handful of tokens that spell the name, so the scopes, the bodies and the DDL are only worked out
 * for the files that have a token worth asking about.
 */
export class OwnerSource {
  readonly #ctx: ResolveContext;
  readonly #src: string;
  readonly #lexed: Lexed;
  readonly #tokens: readonly Token[];

  #scopes?: ReturnType<typeof buildScopes>;
  #statements?: TokenRange[];
  #bodies?: BodyScope[];
  #fileLocals?: Locals;
  readonly #described = new Map<ScopeInfo, Described>();
  readonly #aliases = new Map<number, ReadonlyMap<string, Relation>>();
  readonly #ddl = new Map<number, DdlInfo | null>();

  constructor(ctx: ResolveContext, src: string, lexed: Lexed) {
    this.#ctx = ctx;
    this.#src = src;
    this.#lexed = lexed;
    this.#tokens = lexed.tokens;
  }

  get tokens(): readonly Token[] {
    return this.#tokens;
  }

  /**
   * The catalog tables whose column the identifier at `i` is.
   *
   * `undefined` when it is not a column of a catalog table at all — not a column, or one of something
   * the catalog does not hold. An empty list is the same answer for a name that is a column but of a
   * relation that is not a table (a temporary or derived one).
   */
  columnOwners(i: number): Table[] | undefined {
    const token = this.#tokens[i];
    if (!token || token.t !== "id") return undefined;
    // The qualifier of a longer name is not a column. `db.tbl.col` works because only the one token
    // before the dot is the qualifier.
    if (punct(this.#tokens[i + 1], ".")) return undefined;
    if (punct(this.#tokens[i - 1], ".")) return this.#qualified(i);
    if (!bareColumnCandidate(this.#tokens, i, true)) return undefined;

    const ddl = this.#ddlInfoAt(i);
    if (ddl) return this.#inDdl(i, ddl);
    return this.#bare(i);
  }

  // ------------------------------------------------------------------ plumbing

  get #built(): ReturnType<typeof buildScopes> {
    return (this.#scopes ??= buildScopes(this.#ctx.dialect, this.#tokens));
  }

  get #statementList(): TokenRange[] {
    return (this.#statements ??= statements(this.#tokens));
  }

  /** Index into the statement list of the statement holding a token, or -1 for a `;` or a `BEGIN`. */
  #statementIndex(i: number): number {
    const list = this.#statementList;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = list[mid]!;
      if (i < range.from) hi = mid - 1;
      else if (i > range.to) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** The locals of the routine or trigger a token is in, or the file's own for a loose script. */
  #localsAt(i: number): Locals {
    if (!this.#bodies) {
      const { dialect } = this.#ctx;
      const routines = parseRoutines(this.#src, this.#lexed).routines;
      const found: BodyScope[] = [...routineBodies(dialect, this.#src, this.#tokens, routines)];
      // The same guard the engine uses before it pays for a full DDL parse.
      if (/trigger/i.test(this.#src)) {
        found.push(...triggerBodies(dialect, this.#src, this.#tokens, parseDDL(dialect, this.#src, this.#lexed).triggers));
      }
      this.#bodies = found.sort((a, b) => a.body.from - b.body.from);
      this.#fileLocals = collect(dialect, this.#src, this.#tokens, this.#src.length, routines);
    }
    const body = this.#bodies.find((candidate) => i >= candidate.body.from && i <= candidate.body.to);
    return body ? body.locals : this.#fileLocals!;
  }

  #describe(scope: ScopeInfo, locals: Locals): Described {
    let hit = this.#described.get(scope);
    if (!hit) this.#described.set(scope, (hit = describe(this.#ctx, locals, this.#tokens, scope, true)));
    return hit;
  }

  /** The statement's own alias map, which sees more than a scope's: it descends into the subqueries. */
  #statementAliases(i: number): ReadonlyMap<string, Relation> {
    const at = this.#statementIndex(i);
    if (at === -1) return new Map();
    let hit = this.#aliases.get(at);
    if (!hit) {
      const { dialect } = this.#ctx;
      const range = this.#statementList[at]!;
      const rels = statementRelations(dialect, this.#tokens, range.from, range.to);
      const byAlias = new Map<string, Relation>();
      for (const rel of rels) {
        if (rel.name) byAlias.set(dialect.foldIdentifier(rel.name, false), rel);
      }
      // Aliases go in second so that one shadows a table of the same name.
      for (const rel of rels) {
        if (rel.alias) byAlias.set(dialect.foldIdentifier(rel.alias, false), rel);
      }
      this.#aliases.set(at, (hit = byAlias));
    }
    return hit;
  }

  // ----------------------------------------------------------------- qualified

  #qualified(i: number): Table[] | undefined {
    const qualifier = this.#tokens[i - 2];
    if (!qualifier || qualifier.t !== "id") return undefined;
    const key = this.#ctx.dialect.foldIdentifier(qualifier.v, false);

    // The innermost scope that declares the qualifier, then the statement's own map — the same walk
    // the statement rules make, so a diagnostic and a search read `p.total` as the same table.
    let aliases: ReadonlyMap<string, Relation> | undefined;
    for (let scope = this.#built.owner[i]; scope; scope = scope.parent) {
      if (scope.byAlias.has(key)) {
        aliases = scope.byAlias;
        break;
      }
    }
    aliases ??= this.#statementAliases(i);

    const resolved = qualifierIn(this.#ctx, aliases, this.#localsAt(i), qualifier.v);
    return resolved?.table ? [resolved.table] : undefined;
  }

  // --------------------------------------------------------------------- bare

  #bare(i: number): Table[] | undefined {
    const { dialect, catalog } = this.#ctx;
    const token = this.#tokens[i]!;
    const key = dialect.foldIdentifier(token.v, false);
    const locals = this.#localsAt(i);
    const innermost = this.#built.owner[i];

    // A name that means something else here is not a column reference.
    if (
      locals.byName.has(key) ||
      catalog.table(token.v) ||
      catalog.routine(token.v) ||
      catalog.tempTable(token.v) ||
      (innermost && this.#describe(innermost, locals).defines.has(i))
    ) {
      return undefined;
    }

    for (let scope = innermost; scope; scope = scope.parent) {
      const info = this.#describe(scope, locals);
      const holders = info.holders.get(key);
      if (!holders) continue;
      // The first scope that has the name is the answer, and nothing further out is looked at. Past
      // `GROUP BY` the name may be the select list's own output, which is not a column of anything.
      if (i >= info.tail && info.aliased.has(key)) return undefined;
      const tables: Table[] = [];
      for (const holder of holders) if (holder.table && !tables.includes(holder.table)) tables.push(holder.table);
      return tables;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------- DDL

  /** The table a `name` / `schema.name` pair stands for, unless it is another database's. */
  #tableNamed(name: string | undefined, schema: string | undefined): Table | undefined {
    if (name === undefined) return undefined;
    if (foreignSchema(this.#ctx, { name, ...(schema ? { schema } : {}), offset: 0 })) return undefined;
    return this.#ctx.catalog.table(name);
  }

  /** Is the token inside the DDL part of a `CREATE TABLE`, `ALTER TABLE` or `CREATE INDEX`? */
  #ddlInfoAt(i: number): DdlInfo | undefined {
    const at = this.#statementIndex(i);
    if (at === -1) return undefined;
    let info = this.#ddl.get(at);
    if (info === undefined) {
      info = this.#readDdl(this.#statementList[at]!);
      this.#ddl.set(at, info);
    }
    return info && i <= info.to ? info : undefined;
  }

  #readDdl(range: TokenRange): DdlInfo | null {
    const tokens = this.#tokens;
    const first = tokens[range.from];
    let nameIdx = -1;
    let to = range.to;
    let temporary = false;

    if (kw(first, "CREATE")) {
      const { keyword, keywordIdx } = objectAfterCreate(tokens, range.from);
      if (keyword === "TABLE") {
        for (let j = range.from + 1; j < keywordIdx; j++) if (kw(tokens[j], "TEMPORARY")) temporary = true;
        nameIdx = keywordIdx + 1;
        if (kw(tokens[nameIdx], "IF") && kw(tokens[nameIdx + 1], "NOT") && kw(tokens[nameIdx + 2], "EXISTS")) {
          nameIdx += 3;
        }
        // What follows the column list is a query, and a query's names are resolved as one. `ON
        // UPDATE CURRENT_TIMESTAMP` is no help in telling where the list ends, which is why this
        // looks for the `SELECT` and not for a scope.
        for (let j = nameIdx; j <= range.to; j++) {
          if (kw(tokens[j], "SELECT")) {
            to = j - 1;
            break;
          }
        }
      } else if (keyword === "INDEX") {
        for (let j = keywordIdx + 1; j <= range.to; j++) {
          if (kw(tokens[j], "ON")) {
            nameIdx = j + 1;
            break;
          }
        }
      } else {
        return null;
      }
    } else if (kw(first, "ALTER")) {
      for (let j = range.from + 1; j <= Math.min(range.from + 3, range.to); j++) {
        if (kw(tokens[j], "TABLE")) {
          nameIdx = j + 1;
          break;
        }
      }
    }
    if (nameIdx === -1) return null;

    const target = qualifiedName(tokens, nameIdx);
    const skip = new Set<number>();
    for (let j = nameIdx; j < target.nextIdx; j++) skip.add(j);
    const table = temporary ? undefined : this.#tableNamed(target.name, target.schema);

    const references: DdlInfo["references"] = [];
    for (let j = target.nextIdx; j <= to; j++) {
      if (!kw(tokens[j], "REFERENCES")) continue;
      const named = qualifiedName(tokens, j + 1);
      for (let k = j + 1; k < named.nextIdx; k++) skip.add(k);
      if (!punct(tokens[named.nextIdx], "(")) continue;
      const close = matchingParen(tokens, named.nextIdx);
      if (close === -1) continue;
      references.push({ from: named.nextIdx + 1, to: close - 1, table: this.#tableNamed(named.name, named.schema) });
    }

    return { ...(table ? { table } : {}), to, skip, references };
  }

  #inDdl(i: number, ddl: DdlInfo): Table[] | undefined {
    const tokens = this.#tokens;
    const token = tokens[i]!;
    if (ddl.skip.has(i)) return undefined;
    // The name of a constraint or an index, which sits right after the word that introduces it.
    const before = tokens[i - 1];
    if (NAMES_A_THING.some((word) => kw(before, word))) return undefined;
    // A language word is only a column where a column is expected: opening a definition, in a list,
    // or after `COLUMN`. `COMMENT 'x'` and `PRIMARY KEY` are not the columns of that name.
    if (token.q !== true && isKeyword(token.v)) {
      const expected = punct(before, "(") || punct(before, ",") || kw(before, "COLUMN");
      if (!expected || tokens[i + 1]?.t === "str") return undefined;
    }

    for (const list of ddl.references) {
      if (i >= list.from && i <= list.to) return list.table ? [list.table] : undefined;
    }
    return ddl.table ? [ddl.table] : undefined;
  }
}

/**
 * The catalog tables whose column the identifier at token `i` is. See `OwnerSource.columnOwners`.
 *
 * A function rather than only a method so that a caller reads it as the question it is: the source
 * is built once for a file and then asked about as many tokens as it likes.
 */
export function columnOwners(file: OwnerSource, i: number): Table[] | undefined {
  return file.columnOwners(i);
}
