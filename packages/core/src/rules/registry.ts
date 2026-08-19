/**
 * The registry, and the single pass that runs every rule.
 *
 * ## Why the engine walks and the rules do not
 *
 * The expensive parts of checking a file are shared: which relations a statement names, which of
 * them resolve to real tables, how the file breaks into queries, what the enclosing routine
 * declares. If each rule walked the file itself, one pass would become one per rule and the
 * shared work would be redone every time — on a repo of thousands of procedures that is the
 * difference between usable and not.
 *
 * So the traversal lives here. A rule declares which subject it wants — the file, a statement, a
 * table, a trigger — and is handed that subject with the shared work already done. Even the token
 * indexes worth stopping at inside a statement (`CALL`, `INSERT`, a qualified name) are collected
 * in the engine's own pass and handed over, so that a dozen statement rules do not each rescan the
 * same tokens.
 *
 * ## What the engine owns and rules never see
 *
 * The cap, the de-duplication, the suppression comments and the effective severity. A rule calls
 * `report` and does not know, or need to know, whether the finding survived: those policies have
 * to be uniform to mean anything, and a rule that could opt out of the cap would defeat it.
 */

import type { Config } from "../config/config.ts";
import type { Diagnostic, DiagnosticTag, Severity } from "../diagnostics.ts";
import type { Dialect } from "../dialects/dialect.ts";
import type { Locals } from "../model/locals.ts";
import type { QueryScope, Relation } from "../model/query.ts";
import type { Routine } from "../model/routine.ts";
import type { Table } from "../model/table.ts";
import { collect } from "../analysis/locals.ts";
import { relation as resolveRelation } from "../analysis/resolve.ts";
import { parseDDL } from "../syntax/fast/ddl.ts";
import { lineCol, lineIndex, tokenize } from "../syntax/fast/lexer.ts";
import { parseRoutines } from "../syntax/fast/routine.ts";
import { cteNames, queryScopes, relations as statementRelations, statements } from "../syntax/fast/stmt.ts";
import { kw, kwAny } from "../syntax/fast/tok.ts";
import type { Span, Token, TokenRange } from "../syntax/types.ts";
import type {
  DocumentContext,
  RoutineContext,
  Rule,
  RuleCatalog,
  ScopeInfo,
  StatementContext,
  TableContext,
  TriggerContext,
} from "./rule.ts";

/**
 * Per-file cap, so that one systematic false positive cannot fill a screen or a quickfix list.
 *
 * **What it drops is chosen, not whatever arrived last.** The cap used to cut the tail of the list as
 * it was built, which meant a `hint` reported early kept its place while an `error` found later fell
 * off — the file that most needs reading losing the finding that most needed saying. Severity decides
 * now: an error is never dropped for a warning, nor a warning for a hint.
 *
 * And a capped file says so. A result that was cut with no sign of it is the same defect these rules
 * are about — an answer that looks complete and is not — so one more diagnostic goes at the end
 * saying how many are missing.
 */
const MAX_DIAGNOSTICS = 100;

/** Silences the following line — the line where the thing being hidden lives. */
const IGNORE_MARKER = "sqldex:ignore";

/** Silences the whole file. */
const IGNORE_FILE_MARKER = "sqldex:ignore-file";

/**
 * Words a statement starts with when it is DDL, which is not checked as a query.
 *
 * A `CREATE TABLE` has no `FROM`, but every foreign key in it has an `ON UPDATE RESTRICT`, and
 * read as a query that invents a table called `RESTRICT`. Skipping DDL here is not an
 * optimisation: it is the difference between the query rules being usable and being noise.
 */
const DDL_STARTERS = new Set(["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "GRANT", "REVOKE"]);

/**
 * Does the file build SQL as a string?
 *
 * With `PREPARE` the table names come out of a variable, and static analysis has no way to follow
 * them: everything flagged in such a file is a false positive. Skipping the file whole is both
 * cheaper and more honest than reasoning about half of it.
 */
function usesDynamicSql(src: string): boolean {
  return /prepare/i.test(src);
}

/** Is a full DDL parse of this file worth it? Mirrors the catalog's own prefilter. */
function holdsDDL(src: string): boolean {
  return /(create[ \t\n\v\f\r]+(temporary[ \t\n\v\f\r]+)?table)|trigger/i.test(src);
}

/** The half of `holdsDDL` worth parsing the DDL for when only the triggers are wanted. */
const HOLDS_TRIGGER = /trigger/i;

/**
 * A body a statement can sit inside, and the locals that body gives it.
 *
 * The file's own locals are not those of anything in particular: `collect` reads the whole file, so
 * its `routine` is whichever one comes last and its `triggerTable` is whichever trigger comes last.
 * A statement has to be resolved against the body it is actually in, or a second routine in the file
 * makes the first one's parameters look like columns nothing declares.
 */
interface BodyScope {
  body: TokenRange;
  locals: Locals;
}

/** A `BodyScope` that is a routine, which the routine traversal also needs the routine itself for. */
interface RoutineScope extends BodyScope {
  routine: Routine;
}

/**
 * `group/name`, lower case, with the name in kebab-case.
 *
 * Checked rather than assumed because the `id` is public and permanent: a typo found by whoever
 * first writes it into their config is found far too late.
 */
const ID_SHAPE = /^[a-z]+\/[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export class Registry {
  private readonly byId = new Map<string, Rule>();

  /**
   * Registration is by `id`. Two things are refused rather than tolerated:
   *
   *   - **A duplicate id**, because last-one-wins would silently drop a rule.
   *   - **An `id` whose prefix is not the `group`.** The prefix and the field are the same fact
   *     written twice, which is exactly the drift that makes a code scheme worthless — a rule
   *     called `audit/…` that answers to the `names` group would be silenced by the wrong config
   *     key and nothing would say so.
   */
  add(...rules: readonly Rule[]): this {
    for (const rule of rules) {
      if (!ID_SHAPE.test(rule.id)) throw new Error(`rule id is not group/kebab-case: ${rule.id}`);
      if (!rule.id.startsWith(`${rule.group}/`)) {
        throw new Error(`rule id ${rule.id} disagrees with its group ${rule.group}`);
      }
      if (this.byId.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
      this.byId.set(rule.id, rule);
    }
    return this;
  }

  get(id: string): Rule | undefined {
    return this.byId.get(id);
  }

  /**
   * Registration order, which is the order they run in — and that is a decision, not an accident.
   *
   * De-duplication is first-come-wins, so the order decides which rule gets to claim a token that
   * two of them can see: the column that does not exist, inside an `INSERT` list, should be
   * reported as the specific thing it is and not as a generic unknown name. Sorting by `id` would
   * hand that choice to the alphabet.
   */
  inOrder(): Rule[] {
    return [...this.byId.values()];
  }

  /** Sorted by `id`, for listing rules to a person. Never for running them — see `inOrder`. */
  all(): Rule[] {
    return this.inOrder().sort((a, b) => a.id.localeCompare(b.id));
  }
}

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
function buildScopes(
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

/** What a rule reports at here, or `undefined` when it is silenced. */
function effectiveSeverity(rule: Rule, config: Config): Severity | undefined {
  const perRule = config.diagnostics.rules[rule.id];
  if (perRule !== undefined) return perRule === "off" ? undefined : perRule;

  const perGroup = config.diagnostics.groups[rule.group];
  if (perGroup !== undefined) return perGroup === "off" ? undefined : perGroup;

  return rule.severity;
}

/** A rule that applies here: enabled, and written for this dialect. */
interface Active {
  rule: Rule;
  severity: Severity;
}

export interface CheckOptions {
  dialect: Dialect;
  catalog: RuleCatalog;
  /** The schemas this project defines, folded. */
  schemas: ReadonlySet<string>;
  config: Config;
}

/**
 * Runs the registry over one file's source.
 *
 * The order is not cosmetic. Document rules go first, because whether a variable is ever read, or
 * whether an audit table has fallen behind, is a question about the whole file — and because the
 * de-duplication is first-come, so the rule with the most specific thing to say about a token
 * should get there first.
 */
/**
 * Drops the findings a rule declared it displaces, once everything has been said.
 *
 * **After the fact, not on the way in**, and that is the whole point of the change: while the
 * de-duplication was "the first rule to claim this offset wins", the answer depended on the order
 * somebody listed the rules in `rules/index.ts`, an order no test could explain and every new rule
 * had to be inserted into by reading the others. Resolving here means the same set of findings comes
 * out whatever order they went in, and what decides is a sentence written on the rule.
 *
 * Only the same **offset** collides. Two findings on two tokens of one statement are two things to
 * fix, however related they are.
 */
/** The order severities are kept in when the cap has to choose. */
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, hint: 2 };

/** The code of the note a capped file carries. Not a rule id, because nothing can silence it. */
const CAPPED = "sqldex:capped";

/**
 * Cuts the file down to the cap, keeping the worst and saying what was left out.
 *
 * The survivors come back in the order they were found, not in the order they were chosen: severity
 * decides *what* is kept, and position decides how it reads. Anything else would shuffle a file's
 * findings around the moment it crossed the cap.
 */
function cap(found: readonly Diagnostic[]): Diagnostic[] {
  if (found.length <= MAX_DIAGNOSTICS) return [...found];

  const kept = new Set(
    found
      .map((diagnostic, at) => ({ diagnostic, at }))
      .sort((a, b) => SEVERITY_ORDER[a.diagnostic.severity] - SEVERITY_ORDER[b.diagnostic.severity] || a.at - b.at)
      .slice(0, MAX_DIAGNOSTICS)
      .map((entry) => entry.at),
  );

  const out = found.filter((_, at) => kept.has(at));
  const dropped = found.length - out.length;
  out.push({
    span: { s: 0, e: 0 },
    code: CAPPED,
    severity: "hint",
    message: `${dropped} more finding${dropped === 1 ? "" : "s"} in this file are not shown: it is over the cap of ${MAX_DIAGNOSTICS}`,
  });
  return out;
}

function resolve(found: readonly Diagnostic[], registry: Registry): Diagnostic[] {
  const displaced = new Map<string, Set<string>>();
  for (const diagnostic of found) {
    const supersedes = registry.get(diagnostic.code)?.supersedes;
    if (!supersedes) continue;
    const at = displaced.get(`${diagnostic.span.s}`) ?? new Set<string>();
    for (const code of supersedes) at.add(code);
    displaced.set(`${diagnostic.span.s}`, at);
  }
  if (displaced.size === 0) return [...found];
  return found.filter((diagnostic) => !displaced.get(`${diagnostic.span.s}`)?.has(diagnostic.code));
}

export function check(registry: Registry, options: CheckOptions, src: string): Diagnostic[] {
  const { dialect, catalog, schemas, config } = options;
  if (usesDynamicSql(src)) return [];

  const active: Active[] = [];
  for (const rule of registry.inOrder()) {
    if (rule.dialects && !rule.dialects.includes(dialect.id)) continue;
    const severity = effectiveSeverity(rule, config);
    if (severity !== undefined) active.push({ rule, severity });
  }
  if (active.length === 0) return [];

  const lexed = tokenize(src);
  const tokens = lexed.tokens;
  const starts = lineIndex(src);

  // Suppression is read before anything runs: a `-- sqldex:ignore` is about a line, and a rule
  // must not be able to tell whether it was heard.
  let ignoreWholeFile = false;
  const suppressedLines = new Map<number, Set<string> | true>();
  for (const comment of lexed.comments) {
    if (comment.v.includes(IGNORE_FILE_MARKER)) {
      ignoreWholeFile = true;
      continue;
    }
    const at = comment.v.indexOf(IGNORE_MARKER);
    if (at === -1) continue;
    // What follows the marker, if anything: a rule id, or a group name.
    const rest = comment.v
      .slice(at + IGNORE_MARKER.length)
      .split(/[\s,]+/)
      .filter(Boolean);
    const line = lineCol(starts, comment.s).line + 1;
    if (rest.length === 0) {
      suppressedLines.set(line, true);
      continue;
    }
    const existing = suppressedLines.get(line);
    if (existing === true) continue;
    const set = existing ?? new Set<string>();
    for (const what of rest) set.add(what);
    suppressedLines.set(line, set);
  }
  if (ignoreWholeFile) return [];

  const out: Diagnostic[] = [];

  // The locals of the whole file, not up to a point: a temporary table declared further down must
  // not make a use of it further up look unresolved.
  const parsedRoutines = parseRoutines(src, lexed);
  const locals: Locals = collect(dialect, src, tokens, src.length, parsedRoutines.routines);

  let current: Active | undefined;
  const report = (at: Span | Token, message: string, tags?: DiagnosticTag[]): void => {
    const rule = current!;
    const line = lineCol(starts, at.s).line;
    const suppressed = suppressedLines.get(line);
    if (suppressed === true) return;
    if (suppressed?.has(rule.rule.id) || suppressed?.has(rule.rule.group)) return;

    out.push({
      span: { s: at.s, e: at.e },
      code: rule.rule.id,
      severity: rule.severity,
      message,
      ...(tags ? { tags } : {}),
    });
  };

  const base = { dialect, catalog, schemas, src, tokens, locals, report };

  const documentRules = active.filter((a) => a.rule.scope === "document");
  const routineRules = active.filter((a) => a.rule.scope === "routine");
  const statementRules = active.filter((a) => a.rule.scope === "statement");
  const tableRules = active.filter((a) => a.rule.scope === "table");
  const triggerRules = active.filter((a) => a.rule.scope === "trigger");

  // Lazy and memoised, and shared by both traversals that want it: `routine/unused-variable` needs
  // no scopes at all and a file of pure DDL needs none either, while the ambiguity rule and every
  // qualified reference both do — and between them they should pay once.
  let builtScopes: { infos: ScopeInfo[]; owner: (ScopeInfo | undefined)[] } | undefined;
  const build = (): { infos: ScopeInfo[]; owner: (ScopeInfo | undefined)[] } => {
    builtScopes ??= buildScopes(dialect, tokens);
    return builtScopes;
  };
  let builtStatements: TokenRange[] | undefined;

  // The same, for the DDL: the table traversal, the trigger traversal and the body scopes below all
  // want it, and a file is parsed for it at most once.
  let builtDDL: ReturnType<typeof parseDDL> | undefined;
  const ddlOf = (): ReturnType<typeof parseDDL> => (builtDDL ??= parseDDL(dialect, src, lexed));

  // One routine's body, with the locals that belong to it and nothing else.
  let builtRoutineScopes: RoutineScope[] | undefined;
  const routineScopes = (): RoutineScope[] => {
    if (builtRoutineScopes) return builtRoutineScopes;
    const found = parsedRoutines.routines;
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
    return (builtRoutineScopes = out);
  };

  // A trigger's body is the other place a statement sits inside something that gives it names —
  // `NEW` and `OLD` — and a file with two triggers has two different tables behind them.
  let builtTriggerScopes: BodyScope[] | undefined;
  const triggerScopes = (): BodyScope[] => {
    if (builtTriggerScopes) return builtTriggerScopes;
    const out: BodyScope[] = [];
    if (!HOLDS_TRIGGER.test(src)) return (builtTriggerScopes = out);
    for (const trigger of ddlOf().triggers) {
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
    return (builtTriggerScopes = out);
  };

  // Both kinds together, in source order, which is the order the statements come in.
  let builtBodies: BodyScope[] | undefined;
  const bodies = (): BodyScope[] =>
    (builtBodies ??= [...routineScopes(), ...triggerScopes()].sort((a, b) => a.body.from - b.body.from));

  if (documentRules.length > 0) {
    const ctx: DocumentContext = {
      ...base,
      scopes: () => build().infos,
      scopeAt: (index) => build().owner[index],
      statements: () => (builtStatements ??= statements(tokens)),
    };
    for (const entry of documentRules) {
      current = entry;
      if (entry.rule.scope === "document") entry.rule.check(ctx);
    }
  }

  if (routineRules.length > 0 && parsedRoutines.routines.length > 0) {
    for (const { routine, body, locals: own } of routineScopes()) {
      let bodyStatements: TokenRange[] | undefined;
      const ctx: RoutineContext = {
        ...base,
        locals: own,
        routine,
        body,
        statements: () =>
          (bodyStatements ??= statements(tokens).filter((s) => s.from >= body.from && s.to <= body.to)),
      };
      for (const entry of routineRules) {
        current = entry;
        if (entry.rule.scope === "routine") entry.rule.check(ctx);
      }
    }
  }

  if ((tableRules.length > 0 || triggerRules.length > 0) && holdsDDL(src)) {
    const ddl = ddlOf();
    if (tableRules.length > 0) {
      for (const table of ddl.tables) {
        // A temporary table is not part of the schema: it has no audit twin, no place in the
        // type census, and its columns are whatever the `SELECT` that filled it produced.
        if (table.temporary) continue;
        const ctx: TableContext = { ...base, table };
        for (const entry of tableRules) {
          current = entry;
          if (entry.rule.scope === "table") entry.rule.check(ctx);
        }
      }
    }
    for (const trigger of ddl.triggers) {
      const ctx: TriggerContext = { ...base, trigger };
      for (const entry of triggerRules) {
        current = entry;
        if (entry.rule.scope === "trigger") entry.rule.check(ctx);
      }
    }
  }

  if (statementRules.length > 0) {
    const bodyScopes = bodies();
    // Both lists are in source order and the bodies do not overlap, so one pointer walks them
    // together instead of searching the bodies again for every statement.
    let atBody = 0;
    for (const statement of statements(tokens)) {
      if (kwAny(tokens[statement.from], DDL_STARTERS)) continue;

      while (atBody < bodyScopes.length && bodyScopes[atBody]!.body.to < statement.from) atBody++;
      const enclosing = bodyScopes[atBody];
      // The file's locals are right only for a statement that is in no body at all: a script, or the
      // `INSERT`s of a `carga-valores/` file. Inside one, they are that body's.
      const scope =
        enclosing && statement.from >= enclosing.body.from && statement.to <= enclosing.body.to
          ? enclosing.locals
          : locals;

      const rels = statementRelations(dialect, tokens, statement.from, statement.to);
      const byAlias = new Map<string, Relation>();
      for (const rel of rels) {
        if (rel.name) byAlias.set(dialect.foldIdentifier(rel.name, false), rel);
      }
      // Aliases go in second so that one shadows a table of the same name, which is the order
      // MySQL resolves them in.
      for (const rel of rels) {
        if (rel.alias) byAlias.set(dialect.foldIdentifier(rel.alias, false), rel);
      }

      const resolved: Table[] = [];
      for (const rel of rels) {
        const hit = resolveRelation({ dialect, catalog, schemas }, scope, rel);
        if (hit?.table) resolved.push(hit.table);
      }

      // One pass over the statement, collecting what the rules would otherwise each scan for.
      const calls: number[] = [];
      const inserts: number[] = [];
      const qualified: number[] = [];
      for (let i = statement.from; i <= statement.to; i++) {
        const t = tokens[i]!;
        if (t.t === "punct") {
          if (
            t.v === "." &&
            tokens[i - 1]?.t === "id" &&
            tokens[i + 1]?.t === "id" &&
            i - 1 >= statement.from
          ) {
            qualified.push(i);
          }
          continue;
        }
        if (kw(t, "CALL")) calls.push(i);
        else if (kw(t, "INSERT") || kw(t, "REPLACE")) inserts.push(i);
      }

      const ctx: StatementContext = {
        ...base,
        locals: scope,
        statement,
        relations: rels,
        byAlias,
        resolved,
        calls,
        inserts,
        qualified,
        aliasesFor: (index, folded) => {
          let scope = build().owner[index];
          while (scope) {
            if (scope.byAlias.has(folded)) return scope.byAlias;
            scope = scope.parent;
          }
          // The statement's map sees more — it descends into the subqueries — and it is what every
          // reference resolved against before scopes existed, so nothing that worked stops working.
          return byAlias;
        },
        scopeAt: (index) => build().owner[index],
      };
      for (const entry of statementRules) {
        current = entry;
        if (entry.rule.scope === "statement") entry.rule.check(ctx);
      }
    }
  }

  return cap(resolve(out, registry));
}
