import { columnTypeCensus } from "../../catalog/catalog.ts";
import { cteNames, opensStatement, statements } from "../../syntax/fast/stmt.ts";
import { kw, kwAny, punct } from "../../syntax/fast/tok.ts";
import { intoAt } from "../shared/selects.ts";
import { assignmentTargets, statementSetTargets } from "../shared/writes.ts";
import { bareColumnCandidate, knownBareName, selectOutputAliases } from "../shared/names.ts";
import type { Token, TokenRange } from "../../syntax/types.ts";
import type { Rule, StatementContext } from "../rule.ts";

/**
 * Words that can open a `SET` target position, right before what actually names a system variable
 * rather than a local — `SET GLOBAL x = 1`, `SET SESSION sql_mode = ''`. A target sitting right
 * after one of these is never a candidate for being an undeclared local.
 */
const SCOPE_MODIFIERS: ReadonlySet<string> = new Set(["GLOBAL", "SESSION", "LOCAL", "PERSIST", "PERSIST_ONLY"]);

/** The key the type census is filed under, shared with `schema/divergent-type` so a second asker
 * of the same question pays nothing. */
const CENSUS = "column-types";

/** One name's evidence, gathered over a whole routine or trigger body at once. */
interface NameEvidence {
  /** Bare targets of a `SELECT`/`FETCH … INTO`: never a column, always reported once qualifying. */
  into: Set<number>;
  /** Bare targets of a `SET` that opens a statement of its own. */
  set: Set<number>;
  /** Every bare mention outside a write position: what a read of a name some write showed to be a
   * local is reported from, and the candidates for a read in a statement with no table. */
  reads: Set<number>;
}

/**
 * Evidence for every candidate name in a body, memoised per body so that the statement this engine
 * calls the rule with for the routine's tenth line does not re-walk the other nine.
 *
 * Keyed by the token array first and the body's own start second: the array lives for one `check`,
 * and a file can hold more than one routine, each with its own evidence.
 */
const evidenceCache = new WeakMap<readonly Token[], Map<number, Map<string, NameEvidence>>>();

function entryFor(evidence: Map<string, NameEvidence>, key: string): NameEvidence {
  let e = evidence.get(key);
  if (!e) evidence.set(key, (e = { into: new Set(), set: new Set(), reads: new Set() }));
  return e;
}

function buildEvidence(ctx: StatementContext, body: TokenRange): Map<string, NameEvidence> {
  const { dialect, tokens, locals } = ctx;
  const evidence = new Map<string, NameEvidence>();
  const fold = (token: Token): string => dialect.foldIdentifier(token.v, token.q === true);

  // `INTO` targets: only a `SELECT` or a `FETCH` can have one, and it can only ever name a
  // variable — never a column, so nothing here needs the catalog's opinion.
  // Anywhere a statement opens, not just where a range does: the range of `IF … THEN SELECT … INTO v`
  // starts at the `IF`.
  for (const stmt of statements(tokens).filter((s) => s.from >= body.from && s.to <= body.to)) {
    for (let at = stmt.from; at <= stmt.to; at++) {
      if (!kw(tokens[at], "SELECT") && !kw(tokens[at], "FETCH")) continue;
      if (!opensStatement(tokens, at, stmt.from)) continue;
      const into = intoAt(tokens, at, stmt.to);
      if (into === -1) continue;

      let i = into + 1;
      while (tokens[i]?.t === "id") {
        const token = tokens[i]!;
        if (!token.v.startsWith("@")) {
          const key = fold(token);
          if (!locals.byName.has(key)) entryFor(evidence, key).into.add(i);
        }
        if (punct(tokens[i + 1], ",")) i += 2;
        else break;
      }
    }
  }

  // `SET` targets: only a `SET` that opens a statement of its own can be naming a local rather
  // than the column of an `UPDATE`/`INSERT`, a system variable named by its scope, or one of the
  // handful of `SET` forms — `PASSWORD`, `NAMES` — that mean something else entirely.
  const setTargets = statementSetTargets(tokens, body.from, body.to);
  for (const idx of setTargets) {
    if (!bareColumnCandidate(tokens, idx)) continue;
    if (!punct(tokens[idx + 1], "=") && !punct(tokens[idx + 1], ":=")) continue;
    if (kwAny(tokens[idx - 1], SCOPE_MODIFIERS) !== undefined) continue;

    const key = fold(tokens[idx]!);
    if (locals.byName.has(key)) continue;
    entryFor(evidence, key).set.add(idx);
  }

  // Reads: every bare name in the body, wherever it is not itself the destination of a write —
  // otherwise a `SET`'s own target would count as evidence of being read, and no `SET` would ever
  // stand down. `assignmentTargets` alone does not say that of `SET SESSION tmp_table_size = …`: its
  // list starts at the scope word and stops there, so the name after it — and every name after a
  // comma in the same `SET` — would pass for a read, and a system variable set twice, once scoped
  // and once bare, would be reported as a local nobody declared.
  const { written } = assignmentTargets(ctx);
  for (let i = body.from; i <= body.to; i++) {
    if (written.has(i) || setTargets.has(i) || !bareColumnCandidate(tokens, i)) continue;
    if (kwAny(tokens[i - 1], SCOPE_MODIFIERS) !== undefined) continue;
    const key = fold(tokens[i]!);
    if (locals.byName.has(key)) continue;
    entryFor(evidence, key).reads.add(i);
  }

  return evidence;
}

function evidenceFor(ctx: StatementContext): Map<string, NameEvidence> | undefined {
  const body = ctx.body;
  if (!body) return undefined;

  let byBody = evidenceCache.get(ctx.tokens);
  if (!byBody) evidenceCache.set(ctx.tokens, (byBody = new Map()));

  let evidence = byBody.get(body.from);
  if (!evidence) byBody.set(body.from, (evidence = buildEvidence(ctx, body)));
  return evidence;
}

/**
 * Does this name's evidence add up to "undeclared", for the tokens that *write* it — an `INTO` target
 * or a `SET` target?
 *
 * An `INTO` target always does: there is no other thing it could be. A `SET` target does unless the
 * dialect says the name is a system variable, which is the one thing a bare `SET` can name besides a
 * local. A column cannot be the destination of a statement-level `SET`, so no table in the schema
 * has any say here, and neither does whether the name is ever read: `SET v_typo = 1` is refused at
 * `CREATE` whether or not anything looks at `v_typo` afterwards.
 */
function writeQualifies(ctx: StatementContext, key: string, e: NameEvidence, i: number): boolean {
  if (e.into.size > 0) return true;
  return e.set.has(i) && !ctx.dialect.isSystemVariable(key);
}

/**
 * Does this name's evidence add up to "undeclared", for the tokens that *read* it by the older
 * argument — a name written by `INTO`, or set and read back, that no table has as a column?
 *
 * Both halves of the `SET` case are still needed here, and for the reason they used to be needed for
 * the write itself: a read is the position where a bare name might really be a column, so it only
 * counts as evidence of a local when something wrote the name as one and no table could be meaning it.
 */
function readQualifies(ctx: StatementContext, key: string, e: NameEvidence): boolean {
  if (e.into.size > 0) return true;
  if (e.set.size === 0 || e.reads.size === 0 || ctx.dialect.isSystemVariable(key)) return false;
  const census = ctx.catalog.index(CENSUS, (tables) => columnTypeCensus(ctx.dialect, tables));
  return !census.has(key);
}

/**
 * The statements whose bare words are expressions: where a name that is not a column, a local or a
 * word the language owns can only be a variable somebody forgot to declare.
 */
const EXPRESSION_VERBS: ReadonlySet<string> = new Set([
  "CALL", "IF", "ELSEIF", "RETURN", "SET", "WHILE", "SELECT", "CASE", "DO",
]);

/** The words that may open a `SET` of something other than a variable, whose operands are words. */
const SET_FORMS: ReadonlySet<string> = new Set([
  "NAMES", "CHARACTER", "CHARSET", "TRANSACTION", "PASSWORD", "ROLE", "DEFAULT", "RESOURCE",
]);

/** The words that open a statement inside a range, where a `;` has not cut one. */
const OPENERS: ReadonlySet<string> = new Set(["THEN", "ELSE", "DO", "LOOP", "REPEAT"]);

/** The words that may follow an `END` closing something that is not a `CASE` expression. */
const BLOCK_CLOSERS: ReadonlySet<string> = new Set(["IF", "WHILE", "LOOP", "REPEAT", "CASE"]);

/**
 * For each token of the statement, the first word of the statement it actually sits in — which is
 * the `IF` of `IF v THEN`, and the `SET` of what follows its `THEN`.
 *
 * `statements()` cuts on `;` and `BEGIN` only, so one range holds `IF … THEN SET …`; this walks it
 * and starts over after `THEN`, `ELSE`, `DO`, `LOOP` and `REPEAT`, except where a `THEN` belongs to a
 * `CASE` that is still open, which starts nothing.
 */
function verbs(ctx: StatementContext): (string | undefined)[] {
  const { tokens, statement } = ctx;
  const found: (string | undefined)[] = [];
  let verb: string | undefined;
  let fresh = true;
  let cases = 0;
  for (let i = statement.from; i <= statement.to; i++) {
    const t = tokens[i]!;
    // A `CASE` that opens a statement is the procedural one, whose `THEN` and `ELSE` start statements
    // of their own, like an `IF`'s; only a `CASE` inside an expression holds them back.
    let opensStatement = false;
    if (fresh) {
      verb = t.t === "id" && !t.q ? t.v.toUpperCase() : undefined;
      fresh = false;
      opensStatement = true;
    }
    found[i - statement.from] = verb;
    if (kw(t, "CASE") && !opensStatement && !kw(tokens[i - 1], "END")) cases++;
    else if (kw(t, "END") && cases > 0 && kwAny(tokens[i + 1], BLOCK_CLOSERS) === undefined) cases--;
    else if (cases === 0 && kwAny(t, OPENERS) !== undefined) fresh = true;
  }
  return found;
}

/**
 * Is this bare word, read in a statement with no table in it, one the language gives meaning to
 * rather than a name?
 *
 * Three places a word after something else is a word and not an expression: the operand of a `SET`
 * whose target is not a local — `SET sql_mode = TRADITIONAL`, `SET @@session.autocommit = OFF` — the
 * rest of `SET NAMES utf8mb4` and its kin, and the character set after `CHARACTER SET`/`CHARSET`
 * in a `CAST`. The procedure after `CALL` is not an argument either.
 */
function isWord(ctx: StatementContext, i: number): boolean {
  const { tokens, statement } = ctx;
  if (kw(tokens[i - 1], "CALL") || kw(tokens[i - 1], "CHARSET") || kw(tokens[i - 1], "SET")) return true;

  // The `SET` the token belongs to, and the segment of it (`target = value`) it is in.
  let setAt = -1;
  for (let j = i - 1; j >= statement.from; j--) {
    if (kw(tokens[j], "SET") && (j === statement.from || kwAny(tokens[j - 1], OPENERS) !== undefined)) {
      setAt = j;
      break;
    }
  }
  if (setAt === -1) return false;
  if (kwAny(tokens[setAt + 1], SET_FORMS) !== undefined) return true;

  let depth = 0;
  let segment = setAt + 1;
  for (let j = setAt + 1; j < i; j++) {
    if (punct(tokens[j], "(")) depth++;
    else if (punct(tokens[j], ")")) depth--;
    else if (depth === 0 && punct(tokens[j], ",")) segment = j + 1;
  }
  const target = tokens[segment];
  if (target?.t !== "id") return false;
  if (target.v.startsWith("@@")) return true;
  if (kwAny(target, SCOPE_MODIFIERS) !== undefined) return true;
  if (target.v.startsWith("@") || !bareColumnCandidate(tokens, segment)) return false;
  return !ctx.locals.byName.has(ctx.dialect.foldIdentifier(target.v, target.q === true));
}

export const undeclaredVariable: Rule = {
  id: "routine/undeclared-variable",
  group: "routine",
  severity: "error",
  scope: "statement",
  supersedes: ["names/unqualified-column"],
  docs: `A local used as though a \`DECLARE\` had named it — a \`SET\` target, a \`SELECT\`/\`FETCH …
INTO\` destination, or a name read in a statement that has no table — that no \`DECLARE\` in the
enclosing routine or trigger actually does.

An \`INTO\` can only ever name a variable, never a column, so one that nothing declares is never
ambiguous: the server refuses to create the routine over it, error 1327. A \`SET\` that opens a
statement of its own — as opposed to the \`SET\` clause of an \`UPDATE\` or an \`INSERT\` — is read the
same way: the server resolves a name it does not recognise there as a system variable, and there
being no such variable is again refused at \`CREATE\`, error 1193. MySQL and MariaDB agree on both.

**This displaces \`names/unqualified-column\`** on the same tokens. That rule used to be the only
thing sqldex said here, and it said it in two wrong ways at once: "unknown column" on something that
was never meant as a column, when the statement happened to have a resolved table in it — and nothing
at all when it did not, which a bare \`SET\` or \`IF\` inside procedural code usually does not.

**A \`SET\` target is decided by the dialect's list of system variables, not by whether anything reads
it.** \`SET autocommit = 0\` and \`SET innodb_lock_wait_timeout = 5\` are ordinary system-variable
writes and are left alone; any other name after a bare \`SET\` is not one, and the server refuses the
routine for it whether or not the name is ever used again. The list is the union of MySQL's and
MariaDB's, because nothing in a repository of \`.sql\` files says which of the two it targets, so a
variable only one of them has is not reported as undeclared. A \`SET\` with a scope word
(\`GLOBAL\`, \`SESSION\`, …), a user variable, \`SET NAMES\`, \`SET PASSWORD\` and \`SET TRANSACTION\` are
left alone. No table's columns have a say in a \`SET\` target, because a statement-level \`SET\` cannot
name a column.

**A bare name read in a statement with no table in it** — \`CALL p(v_typo)\`, \`IF v_typo = 1 THEN\`,
\`RETURN v_typo\`, \`WHILE v_typo < 3 DO\`, \`SET v = v_typo + 1\` — is reported too: with no relation in
the statement there is no table for the name to be a column of, and what is left is a variable that
was never declared. **The two servers disagree about when it fails, and the finding is a defect
either way.** MariaDB refuses the routine at \`CREATE\`, error 1327 "Undeclared variable". MySQL
accepts the \`CREATE\` and fails only when the statement runs, error 1054 "Unknown column … in
'field list'" — so on MySQL the routine deploys cleanly and breaks on the call that reaches the line.
Only statements that evaluate expressions (\`CALL\`, \`IF\`, \`ELSEIF\`, \`WHILE\`, \`RETURN\`, \`CASE\`, \`SET\`,
\`SELECT\`, \`DO\`) are read this way; a word the language owns after \`SET\` (\`SET sql_mode =
TRADITIONAL\`, \`SET NAMES utf8mb4\`) or after \`CHARACTER SET\` is not a name. A read in a statement
that does have a table is still \`names/unqualified-column\`'s, because there it may be a column.

**A read of a name that a write showed to be a local is reported too**, but only where no table in the
schema has a column of that name: read bare it would be genuinely ambiguous between the two, and this
only reports what cannot be a column at all.

A statement with no enclosing routine or trigger body is left alone: a loose script has no
\`DECLARE\` section for the name to be missing from.`,

  check(ctx) {
    const evidence = evidenceFor(ctx);
    if (!evidence || evidence.size === 0) return;

    // With anything in the statement unresolved, a bare read could still be a column of the table
    // that did not resolve — guessing which is exactly what `names/unqualified-column` itself
    // refuses to do, and this rule refuses it the same way. An `INTO`/`SET` target is unaffected:
    // neither can be a column syntactically, resolved or not.
    const readsAreSafe = ctx.resolved.length === ctx.relations.length;

    let outputAliases: Set<string> | undefined;
    let ctes: ReadonlySet<string> | undefined;
    let verbOf: (string | undefined)[] | undefined;

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const token = ctx.tokens[i];
      if (!token || token.t !== "id") continue;

      const key = ctx.dialect.foldIdentifier(token.v, token.q === true);
      const e = evidence.get(key);
      if (!e) continue;

      if (e.into.has(i) || e.set.has(i)) {
        if (writeQualifies(ctx, key, e, i)) ctx.report(token, `${token.v} is not declared`);
        continue;
      }
      if (!e.reads.has(i)) continue;

      // A read of a name some write already showed to be meant as a local.
      if (readQualifies(ctx, key, e) && readsAreSafe) {
        outputAliases ??= selectOutputAliases(ctx);
        ctes ??= cteNames(ctx.dialect, ctx.tokens, ctx.statement.from, ctx.statement.to);
        if (!knownBareName(ctx, i, outputAliases, ctes)) ctx.report(token, `${token.v} is not declared`);
        continue;
      }

      // A read in a statement with no table in it, with nothing else to go on: there is no relation
      // for the name to be a column of, so what is left is a variable that was never declared.
      if (ctx.relations.length > 0) continue;
      verbOf ??= verbs(ctx);
      const verb = verbOf[i - ctx.statement.from];
      if (verb === undefined || !EXPRESSION_VERBS.has(verb) || isWord(ctx, i)) continue;

      outputAliases ??= selectOutputAliases(ctx);
      ctes ??= cteNames(ctx.dialect, ctx.tokens, ctx.statement.from, ctx.statement.to);
      if (knownBareName(ctx, i, outputAliases, ctes)) continue;

      ctx.report(token, `${token.v} is not declared`);
    }
  },
};
