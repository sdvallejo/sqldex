/**
 * Query scopes, and the bodies a statement can sit inside.
 *
 * These used to live in the rule registry, because the rules were the only ones asking "which query
 * is this token in, and what does that query declare". Find-references asks the same question about
 * a column and has to get the same answer, so the construction moved out from under the registry
 * rather than being written a second time: two copies would drift, and the drift would show up as
 * the rules and the editor disagreeing about whose column a name is.
 */

import type { Dialect } from "../dialects/dialect.ts";
import type { Locals } from "../model/locals.ts";
import type { QueryScope, Relation } from "../model/query.ts";
import type { Routine } from "../model/routine.ts";
import type { Trigger } from "../model/table.ts";
import type { ScopeInfo } from "../rules/rule.ts";
import { cteNames, queryScopes, relations as statementRelations } from "../syntax/fast/stmt.ts";
import type { Token, TokenRange } from "../syntax/types.ts";
import { collect } from "./locals.ts";

/**
 * The file's query scopes, each with its relations, plus which scope owns each token.
 *
 * Two things here are decisions rather than plumbing:
 *
 *   - **Common table expressions are collected over the whole file, not per scope.** A `WITH` sits
 *     outside the scopes nested inside its body, so a per-range search would miss it there and the
 *     name would resolve against a catalog table that happens to share it. Wrong answer, and a
 *     confidently wrong one.
 *   - **Relations are taken at the scope's own depth** (`shallow`). A scope that reached into its
 *     subqueries would claim their tables as its own, which is the difference between "which
 *     relations could this name belong to" and "which relations appear anywhere below here".
 */
export function buildScopes(
  dialect: Dialect,
  tokens: readonly Token[],
): { infos: ScopeInfo[]; owner: (ScopeInfo | undefined)[] } {
  const ctes = tokens.length > 0 ? cteNames(dialect, tokens, 0, tokens.length - 1) : new Set<string>();
  const raw = queryScopes(tokens);

  const infos: ScopeInfo[] = [];
  const byRaw = new Map<QueryScope, ScopeInfo>();
  for (const scope of raw) {
    const rels = statementRelations(dialect, tokens, scope.from, scope.to, true);
    const byAlias = new Map<string, Relation>();
    for (const rel of rels) {
      if (rel.name && !rel.schema && ctes.has(dialect.foldIdentifier(rel.name, rel.quoted === true))) {
        rel.cte = true;
      }
      if (rel.name) byAlias.set(dialect.foldIdentifier(rel.name, rel.quoted === true), rel);
    }
    for (const rel of rels) {
      if (rel.alias) byAlias.set(dialect.foldIdentifier(rel.alias, rel.aliasQuoted === true), rel);
    }
    const info: ScopeInfo = {
      from: scope.from,
      to: scope.to,
      depth: scope.depth,
      relations: rels,
      byAlias,
    };
    byRaw.set(scope, info);
    infos.push(info);
  }

  // The parent links, once every info exists.
  raw.forEach((scope, i) => {
    if (!scope.parent) return;
    const parent = byRaw.get(scope.parent);
    if (parent) (infos[i] as { parent?: ScopeInfo }).parent = parent;
  });

  // In source order, so a nested scope overwrites its parent's claim on the tokens it covers: a
  // bare name resolves in the innermost scope that has it, the way the engine resolves it.
  const owner: (ScopeInfo | undefined)[] = new Array(tokens.length);
  infos.forEach((info) => {
    for (let i = info.from; i <= info.to; i++) owner[i] = info;
  });

  return { infos, owner };
}

/**
 * A body a statement can sit inside, and the locals that body gives it.
 *
 * The file's own locals are not those of anything in particular: `collect` reads the whole file, so
 * its `routine` is whichever one comes last and its `triggerTable` is whichever trigger comes last.
 * A statement has to be resolved against the body it is actually in, or a second routine in the file
 * makes the first one's parameters look like columns nothing declares.
 */
export interface BodyScope {
  body: TokenRange;
  locals: Locals;
}

/** A `BodyScope` that is a routine, which the routine traversal also needs the routine itself for. */
export interface RoutineScope extends BodyScope {
  routine: Routine;
}

/** One routine's body per routine, with the locals that belong to it and nothing else. */
export function routineBodies(
  dialect: Dialect,
  src: string,
  tokens: readonly Token[],
  found: readonly Routine[],
): RoutineScope[] {
  const out: RoutineScope[] = [];
  // One routine's body runs from the end of its header to the start of the next one's name, which
  // is the bound `collect` already uses to decide which routine an offset belongs to.
  for (const [at, routine] of found.entries()) {
    const endOffset = found[at + 1]?.nameSpan.s ?? src.length;
    let from = 0;
    while (from < tokens.length && tokens[from]!.s < routine.headerEnd) from++;
    let to = from;
    while (to + 1 < tokens.length && tokens[to + 1]!.s < endOffset) to++;
    if (to < from) continue;
    out.push({
      routine,
      body: { from, to },
      // This routine's own locals: its parameters, and the declarations inside its body — not the
      // ones a routine above it in the same file made.
      locals: collect(dialect, src, tokens, endOffset, found, routine.headerEnd),
    });
  }
  return out;
}

/**
 * A trigger's body is the other place a statement sits inside something that gives it names —
 * `NEW` and `OLD` — and a file with two triggers has two different tables behind them.
 */
export function triggerBodies(
  dialect: Dialect,
  src: string,
  tokens: readonly Token[],
  triggers: readonly Trigger[],
): BodyScope[] {
  const out: BodyScope[] = [];
  for (const trigger of triggers) {
    const first = tokens[trigger.body.from];
    const last = tokens[trigger.body.to];
    if (!first || !last) continue;
    out.push({
      body: trigger.body,
      // No routines are passed, because a trigger has no parameters, and `triggerTable` is taken
      // from the parsed trigger rather than re-derived: the walk starts inside the body, past the
      // `ON` clause it would have had to read.
      locals: { ...collect(dialect, src, tokens, last.e, [], first.s), triggerTable: trigger.table },
    });
  }
  return out;
}
