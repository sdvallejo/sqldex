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
import { relations } from "../syntax/fast/stmt.ts";
import { kw, kwAny, matchingParen, objectAfterCreate, punct, qualifiedName, splitCommas, unquote } from "../syntax/fast/tok.ts";
import { readType, typeExtent } from "../syntax/fast/type.ts";
import type { Token } from "../syntax/types.ts";

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

  for (const part of splitCommas(tokens, selectIdx + 1, stop)) {
    const last = tokens[part.to];
    // `*` and `alias.*` name nothing on their own: where they come from is recorded so that
    // whoever has the catalog at hand can expand them.
    if (punct(last, "*")) {
      const owner = tokens[part.to - 2];
      if (punct(tokens[part.to - 1], ".") && owner && owner.t === "id") stars.push(owner.v);
      else if (part.to === part.from) stars.push("*");
    }

    // An explicit alias overrides everything else.
    let aliasIdx = -1;
    let partDepth = 0;
    for (let i = part.from; i <= part.to; i++) {
      const t = tokens[i]!;
      if (t.t === "punct") {
        if (t.v === "(") partDepth++;
        else if (t.v === ")") partDepth--;
      } else if (partDepth === 0 && kw(t, "AS") && tokens[i + 1]?.t === "id") {
        aliasIdx = i + 1;
      }
    }

    if (aliasIdx !== -1) {
      names.push(tokens[aliasIdx]!.v);
      definedAt.add(aliasIdx);
    } else if (last && last.t === "str" && part.to > part.from) {
      // MySQL accepts a literal as an alias: `ROUND(a + b, 2) 'net_total'`, which is common
      // enough to matter. If the literal is the item's only content it is a value, not an alias.
      names.push(unquote(last.v));
    } else if (last && last.t === "id" && !kwAny(last, SELECT_NOISE)) {
      // Without `AS`, it can only be named if the item ends in an identifier: `Col`, or the `Col`
      // of `t.Col`. If it ends in `)` it is an anonymous expression.
      //
      // Whether it also **defines** that name is another matter: `(expr) Total` does, but `Col`
      // and `t.Col` only reference a column that already exists. The distinction matters for the
      // diagnostics, which would otherwise accept any name appearing in a SELECT.
      const definesName = part.to > part.from && !punct(tokens[part.to - 1], ".");
      if (!aliasesOnly || definesName) names.push(last.v);
      if (definesName) definedAt.add(part.to);
    }
  }

  return { names, stars, definedAt };
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
}

/** The columns a `SELECT` produces, descending into derived subqueries. */
function resolveSelect(
  dialect: Dialect,
  tokens: readonly Token[],
  selectIdx: number,
  limit: number,
  depth: number,
): ResolvedSelect {
  const { names, stars } = selectListColumns(tokens, selectIdx, limit);
  const sources: string[] = [];
  if (stars.length === 0 || depth > MAX_DERIVED_DEPTH) return { names, sources };

  // In a `SELECT * FROM a UNION ALL SELECT * FROM b`, the result's columns are defined by the
  // **first** branch. Without stopping here, relations from both are collected and the `*` is no
  // longer unambiguous, which leaves the temporary table it feeds without columns.
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
    if (!relation.derived) return;

    // Anonymous subquery: descend into its own `SELECT` and repeat the analysis.
    for (let i = relation.derived.from; i <= relation.derived.to; i++) {
      if (kw(tokens[i], "SELECT")) {
        const inner = resolveSelect(dialect, tokens, i, relation.derived.to - 1, depth + 1);
        names.push(...inner.names);
        sources.push(...inner.sources);
        return;
      }
    }
  };

  for (const star of stars) {
    if (star === "*") {
      // `SELECT * FROM t`: with a single relation the `*` is unambiguous; with several, not.
      if (found.length === 1) absorb(found[0]!);
    } else {
      const relation = byAlias.get(dialect.foldIdentifier(star, false));
      if (relation) absorb(relation);
    }
  }

  return { names, sources };
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
  let i = 0;
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
