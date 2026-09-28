/**
 * What only exists inside a routine's body: parameters, `DECLARE` variables, cursors and
 * temporary tables.
 *
 * Computed over the file being edited rather than over the catalog, because these only make
 * sense there. Ignoring them would leave completion without half the tables a procedure works
 * with: in procedural MySQL, temporary tables are how intermediate results get passed around.
 */

import type { Dialect } from "../dialects/dialect.ts";
import type { Local, Locals } from "../model/locals.ts";
import type { Routine } from "../model/routine.ts";
import type { Relation } from "../model/query.ts";
import { EXPECTS_TABLE, relations } from "../syntax/fast/stmt.ts";
import { kw, kwAny, matchingParen, objectAfterCreate, punct, qualifiedName, splitCommas, unquote } from "../syntax/fast/tok.ts";
import { readType, TYPE_SUFFIXES, typeExtent } from "../syntax/fast/type.ts";
import type { Span, Token, TokenRange } from "../syntax/types.ts";

const HANDLER_STARTERS: ReadonlySet<string> = new Set(["CONTINUE", "EXIT", "UNDO"]);

/** Words that are not a column name when they close an item of the SELECT list. */
const SELECT_NOISE: ReadonlySet<string> = new Set(["DISTINCT", "ALL", "DISTINCTROW", "STRAIGHT_JOIN"]);

/** Leading words marking an item of a `CREATE TEMPORARY TABLE` list as a constraint. */
const NOT_A_TEMP_COLUMN: ReadonlySet<string> = new Set([
  "INDEX",
  "KEY",
  "PRIMARY",
  "UNIQUE",
  "CONSTRAINT",
  "FOREIGN",
]);

const SET_OPERATORS: ReadonlySet<string> = new Set(["UNION", "EXCEPT", "INTERSECT"]);

export interface SelectListColumns {
  names: string[];
  /** Aliases or tables whose `*` must be expanded (a bare `*` comes as `"*"`). */
  stars: string[];
  /**
   * Token indices where the list **defines** a name — the second `started_at` of
   * `DATE_FORMAT(t.started_at, '%d/%m/%Y') started_at`. Those tokens name a result and are not
   * column references, which only tells them apart by position: the same word appears twice on
   * that line and the first one **is** a column.
   */
  definedAt: Set<number>;
  /**
   * How many items neither named themselves nor were a `*`: an unaliased expression like
   * `COUNT(*)`, or a lone literal with nothing after it. Whoever needs the list to be **complete**
   * — every item accounted for, not just the ones that could be named — reads this rather than
   * comparing `names.length` against the number of commas, since a `*` legitimately contributes no
   * name of its own yet is not missing anything.
   */
  unnamed: number;
  /**
   * The span of the expression each name of `names` came from, when it is one an item computes
   * rather than merely references — `undefined` for `Col` or `t.Col`, which name something that
   * already exists rather than filling anything in. Parallel to `names`.
   */
  origins: (Span | undefined)[];
}

/**
 * Column names from a `SELECT` list, used to infer the columns of a temporary table created with
 * `CREATE TEMPORARY TABLE x ... SELECT ...`.
 *
 * It resolves the forms that can be named (`Col`, `t.Col`, `expr AS alias`) and skips the ones
 * that cannot (`COALESCE(a,0)` without an alias, `SELECT *`): one missing column in completion
 * beats one made up.
 *
 * @param selectIdx Index of the `SELECT` token.
 * @param aliasesOnly Return only the names the SELECT **defines**.
 */
export function selectListColumns(
  tokens: readonly Token[],
  selectIdx: number,
  limit: number,
  aliasesOnly = false,
): SelectListColumns {
  // The list runs up to the depth-zero `FROM`, or to the end of the statement.
  //
  // It also stops at `INTO`, because in a `SELECT a, b INTO pA, pB FROM t` that clause comes
  // **before** the `FROM`: without stopping there, the list's last item merges with the first
  // destination and the alias captured is the variable rather than the column.
  let stop = limit;
  let depth = 0;
  for (let i = selectIdx + 1; i <= limit; i++) {
    const t = tokens[i]!;
    if (t.t === "punct") {
      if (t.v === "(") {
        depth++;
      } else if (t.v === ")") {
        depth--;
        if (depth < 0) {
          stop = i - 1;
          break;
        }
      } else if (t.v === ";" && depth === 0) {
        stop = i - 1;
        break;
      }
    } else if (depth === 0 && (kw(t, "FROM") || kw(t, "INTO"))) {
      stop = i - 1;
      break;
    }
  }

  const names: string[] = [];
  const stars: string[] = [];
  const definedAt = new Set<number>();
  const origins: (Span | undefined)[] = [];
  let unnamed = 0;

  /** Span of `part.from .. before` — the expression an alias sits after — or `undefined` if empty. */
  const expressionBefore = (part: TokenRange, before: number): Span | undefined => {
    if (before < part.from) return undefined;
    return { s: tokens[part.from]!.s, e: tokens[before]!.e };
  };

  for (const part of splitCommas(tokens, selectIdx + 1, stop)) {
    const last = tokens[part.to];
    // `*` and `alias.*` name nothing on their own: where they come from is recorded so that
    // whoever has the catalog at hand can expand them. Either way the item is accounted for, so
    // it is not what `unnamed` counts.
    let named = false;
    if (punct(last, "*")) {
      const owner = tokens[part.to - 2];
      if (punct(tokens[part.to - 1], ".") && owner && owner.t === "id") {
        stars.push(owner.v);
        named = true;
      } else if (part.to === part.from) {
        stars.push("*");
        named = true;
      }
    }

    // An explicit alias overrides everything else.
    let aliasIdx = -1;
    let asIdx = -1;
    let partDepth = 0;
    for (let i = part.from; i <= part.to; i++) {
      const t = tokens[i]!;
      if (t.t === "punct") {
        if (t.v === "(") partDepth++;
        else if (t.v === ")") partDepth--;
      } else if (partDepth === 0 && kw(t, "AS") && tokens[i + 1]?.t === "id") {
        aliasIdx = i + 1;
        asIdx = i;
      }
    }

    if (aliasIdx !== -1) {
      names.push(tokens[aliasIdx]!.v);
      definedAt.add(aliasIdx);
      origins.push(expressionBefore(part, asIdx - 1));
      named = true;
    } else if (last && last.t === "str" && part.to > part.from) {
      // MySQL accepts a literal as an alias: `ROUND(a + b, 2) 'net_total'`, which is common
      // enough to matter. If the literal is the item's only content it is a value, not an alias.
      names.push(unquote(last.v));
      origins.push(expressionBefore(part, part.to - 1));
      named = true;
    } else if (last && last.t === "id" && !kwAny(last, SELECT_NOISE)) {
      // Without `AS`, it can only be named if the item ends in an identifier: `Col`, or the `Col`
      // of `t.Col`. If it ends in `)` it is an anonymous expression.
      //
      // Whether it also **defines** that name is another matter: `(expr) Total` does, but `Col`
      // and `t.Col` only reference a column that already exists. The distinction matters for the
      // diagnostics, which would otherwise accept any name appearing in a SELECT.
      const definesName = part.to > part.from && !punct(tokens[part.to - 1], ".");
      if (!aliasesOnly || definesName) {
        names.push(last.v);
        origins.push(definesName ? expressionBefore(part, part.to - 1) : undefined);
      }
      if (definesName) definedAt.add(part.to);
      named = true;
    }

    if (!named) unnamed++;
  }

  return { names, stars, definedAt, unnamed, origins };
}

/**
 * How many nested derived subqueries a chain of `*` is followed through. Three levels is already
 * unusual in hand-written SQL; six is slack, not a target.
 */
const MAX_DERIVED_DEPTH = 6;

export interface ResolvedSelect {
  names: string[];
  /** Outside tables whose `*` has to be expanded with the catalog, which this module lacks. */
  sources: string[];
  /**
   * Whether every item is accounted for: no unaliased expression, no `*` that could not be traced
   * to exactly one relation, no nested derived subquery that was itself incomplete.
   */
  complete: boolean;
  /**
   * Parallel to `names`: the span of the expression that computes each one, for the names this
   * branch's own list defines directly. A name absorbed from a `*` — this branch's own or a nested
   * subquery's — carries no span of its own here, since it was not this list that wrote it.
   */
  origins: (Span | undefined)[];
}

/** The columns a `SELECT` produces, descending into derived subqueries. */
function resolveSelect(
  dialect: Dialect,
  tokens: readonly Token[],
  selectIdx: number,
  limit: number,
  depth: number,
): ResolvedSelect {
  // In a `SELECT * FROM a UNION ALL SELECT * FROM b`, the result's columns are defined by the
  // **first** branch. Without cutting the list there too, an item with nothing before the `UNION`
  // — `SELECT 'N' AS a UNION SELECT 'S'` has no `FROM` to stop at — bleeds into the next branch's
  // list, and the last thing read is `'S'` rather than `a`.
  let branchLimit = limit;
  let depthInBranch = 0;
  for (let i = selectIdx + 1; i <= limit; i++) {
    const t = tokens[i]!;
    if (t.t === "punct") {
      if (t.v === "(") depthInBranch++;
      else if (t.v === ")") depthInBranch--;
    } else if (depthInBranch === 0 && kwAny(t, SET_OPERATORS)) {
      branchLimit = i - 1;
      break;
    }
  }

  const { names, stars, unnamed, origins } = selectListColumns(tokens, selectIdx, branchLimit);
  const sources: string[] = [];
  let complete = unnamed === 0;

  if (stars.length === 0 || depth > MAX_DERIVED_DEPTH) {
    // Depth exceeded with stars still unresolved is not the same as none: the list stops being
    // complete right there, even though nothing further can be read to prove it.
    if (stars.length > 0 && depth > MAX_DERIVED_DEPTH) complete = false;
    return { names, sources, complete, origins };
  }

  const found = relations(dialect, tokens, selectIdx, branchLimit);
  const byAlias = new Map<string, Relation>();
  for (const relation of found) {
    if (relation.name) byAlias.set(dialect.foldIdentifier(relation.name, relation.quoted === true), relation);
    if (relation.alias) {
      byAlias.set(dialect.foldIdentifier(relation.alias, relation.aliasQuoted === true), relation);
    }
  }

  /** Adds whatever a relation pointed at by a `*` contributes to the results. */
  const absorb = (relation: Relation): void => {
    if (relation.name) {
      // A named table: whoever has the catalog expands it.
      sources.push(relation.name);
      return;
    }
    if (!relation.derived) {
      complete = false;
      return;
    }

    // Anonymous subquery: descend into its own `SELECT` and repeat the analysis.
    for (let i = relation.derived.from; i <= relation.derived.to; i++) {
      if (kw(tokens[i], "SELECT")) {
        const inner = resolveSelect(dialect, tokens, i, relation.derived.to - 1, depth + 1);
        names.push(...inner.names);
        origins.push(...inner.names.map(() => undefined));
        sources.push(...inner.sources);
        if (!inner.complete) complete = false;
        return;
      }
    }
    complete = false;
  };

  for (const star of stars) {
    if (star === "*") {
      // `SELECT * FROM t`: with a single relation the `*` is unambiguous; with several, not.
      if (found.length === 1) absorb(found[0]!);
      else complete = false;
    } else {
      const relation = byAlias.get(dialect.foldIdentifier(star, false));
      if (relation) absorb(relation);
      else complete = false;
    }
  }

  return { names, sources, complete, origins };
}

export interface JsonTableColumn {
  name: string;
  /** Absent for `FOR ORDINALITY`, which has no type of its own — it is always the row number. */
  type?: string;
  /** The `PATH` string, unquoted. Absent for `FOR ORDINALITY`. */
  path?: string;
  ordinality: boolean;
  nameSpan: Span;
}

export interface JsonTableColumns {
  columns: JsonTableColumn[];
  /** The first argument's text, when it is a single identifier — `p_items` in `JSON_TABLE(p_items, ...)`. */
  source?: string;
  /** The second argument, unquoted — the row path every column's own `PATH` is relative to. */
  rootPath?: string;
  /** Whether every item of `COLUMNS(...)` was in a shape this function reads. */
  complete: boolean;
}

/** `{NULL | DEFAULT json_string | ERROR} ON {EMPTY | ERROR}`, read after a column's `PATH`. */
function skipOnClauses(tokens: readonly Token[], from: number, to: number): number | undefined {
  let i = from;
  while (i <= to) {
    if (kw(tokens[i], "NULL") || kw(tokens[i], "ERROR")) {
      i++;
    } else if (kw(tokens[i], "DEFAULT")) {
      i++;
      if (tokens[i]?.t !== "str" && tokens[i]?.t !== "num") return undefined;
      i++;
    } else {
      return undefined;
    }
    if (!kw(tokens[i], "ON") || !(kw(tokens[i + 1], "EMPTY") || kw(tokens[i + 1], "ERROR"))) return undefined;
    i += 2;
  }
  return i;
}

/** A column's type, reconstructed from its tokens — name plus any parenthesised arguments. */
function jsonColumnType(tokens: readonly Token[], typeIdx: number, limit: number): { text: string; last: number } {
  const last = typeExtent(tokens, typeIdx, limit);
  let text = tokens[typeIdx]!.v;
  if (punct(tokens[typeIdx + 1], "(")) {
    const close = matchingParen(tokens, typeIdx + 1);
    if (close !== -1 && close <= last) {
      const args = splitCommas(tokens, typeIdx + 2, close - 1).map((part) =>
        tokens
          .slice(part.from, part.to + 1)
          .map((t) => t.v)
          .join(""),
      );
      text += `(${args.join(",")})`;
    }
  }
  for (let i = typeIdx + 1; i <= last; i++) {
    const suffix = kwAny(tokens[i], TYPE_SUFFIXES);
    if (suffix) text += ` ${suffix}`;
  }
  return { text, last };
}

/**
 * One item of a `COLUMNS(...)` list, appended to `out`. `false` when its shape is not one of the
 * three this reads: `name FOR ORDINALITY`, `name type [EXISTS] PATH 'p' [empty/error clauses]`, or
 * `NESTED [PATH] 'p' COLUMNS(...)`.
 */
function readJsonTableColumn(tokens: readonly Token[], from: number, to: number, out: JsonTableColumn[]): boolean {
  if (kw(tokens[from], "NESTED")) {
    // `NESTED [PATH] 'p' COLUMNS(...)` names nothing on its own: it is flattened into `out`, which
    // is exactly how MySQL itself exposes the nested columns to the surrounding query.
    let i = from + 1;
    if (kw(tokens[i], "PATH")) i++;
    if (tokens[i]?.t !== "str") return false;
    i++;
    if (!kw(tokens[i], "COLUMNS") || !punct(tokens[i + 1], "(")) return false;
    const closeIdx = matchingParen(tokens, i + 1);
    if (closeIdx !== to) return false;
    return readJsonTableColumnList(tokens, i + 1, closeIdx, out);
  }

  const nameToken = tokens[from];
  if (!nameToken || nameToken.t !== "id") return false;
  const nameSpan: Span = { s: nameToken.s, e: nameToken.e };

  if (kw(tokens[from + 1], "FOR") && kw(tokens[from + 2], "ORDINALITY")) {
    if (from + 2 !== to) return false;
    out.push({ name: nameToken.v, ordinality: true, nameSpan });
    return true;
  }

  if (!tokens[from + 1] || tokens[from + 1]!.t !== "id") return false;
  const { text, last } = jsonColumnType(tokens, from + 1, to);
  let i = last + 1;
  if (kw(tokens[i], "EXISTS")) i++;
  if (!kw(tokens[i], "PATH") || tokens[i + 1]?.t !== "str") return false;
  const path = unquote(tokens[i + 1]!.v);
  i += 2;

  if (i <= to && skipOnClauses(tokens, i, to) !== to + 1) return false;

  out.push({ name: nameToken.v, type: text, path, ordinality: false, nameSpan });
  return true;
}

/** A whole `COLUMNS(...)` body: every item split on its own depth-zero commas. */
function readJsonTableColumnList(
  tokens: readonly Token[],
  openIdx: number,
  closeIdx: number,
  out: JsonTableColumn[],
): boolean {
  let complete = true;
  for (const part of splitCommas(tokens, openIdx + 1, closeIdx - 1)) {
    if (!readJsonTableColumn(tokens, part.from, part.to, out)) complete = false;
  }
  return complete;
}

/**
 * `JSON_TABLE(source, '$path' COLUMNS(...))`'s own columns, when `relation` is one — `undefined`
 * for anything else, including a table function this does not recognise by name.
 *
 * `complete` is `false` for any item whose shape is not one `readJsonTableColumn` reads: this
 * stands down on that item rather than guessing at a name or a type it cannot see. `columns` still
 * carries whatever it did read, the same best-effort contract `derivedColumns` keeps.
 */
export function jsonTableColumns(tokens: readonly Token[], relation: Relation): JsonTableColumns | undefined {
  const derived = relation.derived;
  if (!derived) return undefined;
  if (!kw(tokens[derived.from - 1], "JSON_TABLE")) return undefined;

  // `JSON_TABLE(expr, path_expr COLUMNS(...))`: only one comma, between the source and everything
  // else — the row path and `COLUMNS(...)` are not comma-separated from each other.
  const args = splitCommas(tokens, derived.from + 1, derived.to - 1);
  if (args.length !== 2) return { columns: [], complete: false };

  let source: string | undefined;
  const sourceArg = args[0]!;
  if (sourceArg.from === sourceArg.to && tokens[sourceArg.from]?.t === "id") source = tokens[sourceArg.from]!.v;

  const rest = args[1]!;
  if (tokens[rest.from]?.t !== "str") return { columns: [], source, complete: false };
  const rootPath = unquote(tokens[rest.from]!.v);

  const columnsIdx = rest.from + 1;
  if (!kw(tokens[columnsIdx], "COLUMNS") || !punct(tokens[columnsIdx + 1], "(")) {
    return { columns: [], source, rootPath, complete: false };
  }
  const closeIdx = matchingParen(tokens, columnsIdx + 1);
  if (closeIdx === -1 || closeIdx !== rest.to) return { columns: [], source, rootPath, complete: false };

  const columns: JsonTableColumn[] = [];
  const complete = readJsonTableColumnList(tokens, columnsIdx + 1, closeIdx, columns);
  return { columns, source, rootPath, complete };
}

/**
 * A derived table's output columns: `FROM (SELECT ...) t` or the `JSON_TABLE(...)` a relation is
 * shaped the same as.
 *
 * `complete` says whether every column is known: it is `false` when the relation is a table
 * function rather than a real subquery — a table function's `names` comes from `jsonTableColumns`
 * when it recognises one, best-effort like everything else here, but nothing here treats a table
 * function's columns as the *whole* answer the way a real subquery's can be — when what is inside
 * the parentheses is not a `SELECT` (a `VALUES` row constructor, say), when the alias carries its
 * own column list (`(SELECT ...) t (a, b)` renames the output past what the query itself calls
 * it), or when the query's own first branch left something unnamed. `names` is still returned in
 * every case — best-effort — so a caller only after completion candidates is not left with nothing
 * just because one item could not be named.
 */
export function derivedColumns(
  dialect: Dialect,
  tokens: readonly Token[],
  relation: Relation,
): ResolvedSelect | undefined {
  const derived = relation.derived;
  if (!derived) return undefined;

  // A table function shares the subquery's token shape (`readRelation` reads `JSON_TABLE(...)`
  // the same way it reads `(SELECT ...)`), but only a subquery is ever preceded by the tokens
  // `relations()` calls `readRelation` after — `FROM`, `JOIN`, `UPDATE`, `STRAIGHT_JOIN`, a comma.
  // Anything else there is the function's own name.
  const before = tokens[derived.from - 1];
  const isTableFunction = before !== undefined && before.t === "id" && !kwAny(before, EXPECTS_TABLE);

  if (isTableFunction) {
    // Whatever `jsonTableColumns` could read is offered as names, but `complete` stays `false`
    // regardless: rules like `names/unknown-column` stand down on a table function on purpose (see
    // its own `docs`), and that decision is not this function's to revisit.
    const found = jsonTableColumns(tokens, relation);
    const names = found ? found.columns.map((column) => column.name) : [];
    return { names, sources: [], complete: false, origins: names.map(() => undefined) };
  }

  // The alias carries its own column list, which renames the output past what this function reads.
  let after = derived.to + 1;
  if (kw(tokens[after], "AS")) after++;
  if (relation.alias !== undefined) after++;
  const hasColumnList = punct(tokens[after], "(");

  // What is inside the parentheses has to be a `SELECT`; nested `((SELECT ...))` is followed
  // through, anything else is not something this function reads.
  let i = derived.from + 1;
  while (punct(tokens[i], "(")) i++;
  const isSelect = kw(tokens[i], "SELECT");

  if (!isSelect) return { names: [], sources: [], complete: false, origins: [] };

  const resolved = resolveSelect(dialect, tokens, i, derived.to - 1, 0);
  return { ...resolved, complete: resolved.complete && !hasColumnList };
}

/** Reads a `DECLARE`, appending the locals it defines to `out`. */
function readDeclare(src: string, tokens: readonly Token[], declareIdx: number, out: Local[]): void {
  let i = declareIdx + 1;

  // `DECLARE CONTINUE HANDLER FOR SQLEXCEPTION ...` declares no usable name.
  if (kwAny(tokens[i], HANDLER_STARTERS)) return;

  // Names are comma-separated: `DECLARE pA, pB DECIMAL(5,2)`.
  const names: Token[] = [];
  while (tokens[i]?.t === "id") {
    names.push(tokens[i]!);
    if (punct(tokens[i + 1], ",")) {
      i += 2;
    } else {
      i++;
      break;
    }
  }
  if (names.length === 0) return;

  const first = names[0]!;
  if (kw(tokens[i], "CURSOR")) {
    out.push({
      name: first.v,
      quoted: first.q === true,
      kind: "cursor",
      nameSpan: { s: first.s, e: first.e },
    });
    return;
  }
  if (kw(tokens[i], "CONDITION")) return;

  let type;
  let hasDefault = false;
  if (tokens[i]) {
    const last = typeExtent(tokens, i, tokens.length - 1);
    type = readType(src, tokens, i, last);

    // Whether the declaration initialises the variable.
    for (let j = last + 1; tokens[j] && !punct(tokens[j], ";"); j++) {
      if (kw(tokens[j], "DEFAULT")) {
        hasDefault = true;
        break;
      }
    }
  }
  for (const name of names) {
    out.push({
      name: name.v,
      quoted: name.q === true,
      kind: "variable",
      type,
      default: hasDefault,
      nameSpan: { s: name.s, e: name.e },
    });
  }
}

/**
 * Reads a `CREATE TEMPORARY TABLE`, with columns from the parenthesised list or inferred from the
 * `SELECT` that fills it.
 *
 * @param tableIdx Index of the `TABLE` token.
 * @returns Where the walk resumes.
 */
function readTempTable(
  dialect: Dialect,
  tokens: readonly Token[],
  tableIdx: number,
  out: Local[],
): number {
  let i = tableIdx + 1;
  if (kw(tokens[i], "IF") && kw(tokens[i + 1], "NOT") && kw(tokens[i + 2], "EXISTS")) i += 3;

  const nameToken = tokens[i];
  if (!nameToken || nameToken.t !== "id") return tableIdx + 1;

  let columns: string[] = [];
  let iAfter = i + 1;

  if (punct(tokens[iAfter], "(")) {
    const closeIdx = matchingParen(tokens, iAfter);
    if (closeIdx !== -1) {
      for (const part of splitCommas(tokens, iAfter + 1, closeIdx - 1)) {
        const first = tokens[part.from];
        // `CREATE TEMPORARY TABLE tmp(INDEX (a, b)) ... SELECT ...` declares an index, not
        // columns: there the real names come from the SELECT further along.
        if (first && first.t === "id" && !kwAny(first, NOT_A_TEMP_COLUMN)) columns.push(first.v);
      }
      iAfter = closeIdx + 1;
    }
  }

  let sources: string[] | undefined;
  // The span of the expression that fills each column, when it came off the `SELECT` rather than
  // an explicit column list — `undefined` here means this table declared its own columns, not that
  // none of them have an origin. `hover` tells the two apart by whether this is `undefined` at all.
  let columnOrigins: (Span | undefined)[] | undefined;
  if (columns.length === 0) {
    // Find the `SELECT` feeding the table, within the same statement.
    for (let j = iAfter; j <= Math.min(iAfter + 40, tokens.length - 1); j++) {
      if (punct(tokens[j], ";")) break;
      if (kw(tokens[j], "SELECT")) {
        // The bound is the `;` closing this statement, not the end of the file: walking the whole
        // stream per temporary table makes parsing quadratic, and some SPs have dozens.
        let stmtEnd = tokens.length - 1;
        for (let k = j; k < tokens.length; k++) {
          if (punct(tokens[k], ";")) {
            stmtEnd = k - 1;
            break;
          }
        }

        const resolved = resolveSelect(dialect, tokens, j, stmtEnd, 0);
        columns = resolved.names;
        sources = resolved.sources;
        columnOrigins = resolved.origins;
        break;
      }
    }
  }

  out.push({
    name: nameToken.v,
    quoted: nameToken.q === true,
    kind: "temp_table",
    columns,
    sources,
    columnOrigins,
    nameSpan: { s: nameToken.s, e: nameToken.e },
  });
  return iAfter;
}

/**
 * Gathers everything declared before `offset`.
 *
 * Only what is already declared above is offered: in MySQL a `DECLARE` has to sit at the start of
 * the block, so suggesting a variable from further down would be suggesting code that does not
 * compile yet.
 *
 * @param routines Already-parsed routines from the same file.
 */
export function collect(
  dialect: Dialect,
  src: string,
  tokens: readonly Token[],
  offset: number,
  routines: readonly Routine[] = [],
  from = 0,
): Locals {
  const items: Local[] = [];

  // The routine containing the cursor: the last one whose signature starts before it.
  let routine: Routine | undefined;
  for (const candidate of routines) {
    if (candidate.nameSpan.s < offset) routine = candidate;
  }
  if (routine) {
    for (const param of routine.params) {
      // A parameter does not record its own position: it points at the routine's name, which is
      // where the signature declaring it lives.
      items.push({
        name: param.name,
        quoted: param.quoted,
        kind: "param",
        type: param.type,
        nameSpan: routine.nameSpan,
      });
    }
  }

  let triggerTable: string | undefined;
  // `from` is what makes these one routine's locals instead of the file's. A file with two
  // procedures declares each one's variables in its own body, and a walk that starts at zero hands
  // the second one the first one's `DECLARE`s — same names, different variables.
  let i = 0;
  while (i < tokens.length && tokens[i]!.s < from) i++;
  while (i < tokens.length && tokens[i]!.s < offset) {
    const t = tokens[i]!;
    if (kw(t, "DECLARE")) {
      readDeclare(src, tokens, i, items);
      i++;
    } else if (kw(t, "CREATE")) {
      const { keyword, keywordIdx } = objectAfterCreate(tokens, i);
      // `TEMPORARY` only: in a `tablas/` file the real `CREATE TABLE` is already in the global
      // catalog and has no business also showing up as a file-local.
      if (keyword === "TABLE" && kw(tokens[keywordIdx - 1], "TEMPORARY")) {
        i = readTempTable(dialect, tokens, keywordIdx, items);
      } else if (keyword === "TRIGGER") {
        // `NEW`/`OLD` resolve against the table in this trigger's `ON`.
        for (let j = keywordIdx; j <= Math.min(keywordIdx + 12, tokens.length - 1); j++) {
          if (kw(tokens[j], "ON")) {
            triggerTable = qualifiedName(tokens, j + 1).name;
            break;
          }
        }
        i = keywordIdx + 1;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  const byName = new Map<string, Local>();
  for (const item of items) byName.set(dialect.foldIdentifier(item.name, item.quoted), item);

  return { routine, triggerTable, items, byName };
}
