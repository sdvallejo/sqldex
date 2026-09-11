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
  /** Every bare mention outside a write position — what tells `SET autocommit = 0` apart from a
   * name this routine actually treats as a variable. */
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
 * Does this name's evidence add up to "undeclared"?
 *
 * An `INTO` target always does — there is no other thing it could be. A `SET` target only does
 * alongside a read of the same name (a write nobody reads is `SET autocommit = 0`, not a slipped
 * variable) and only when no table in the whole schema has a column of that name, which is what
 * keeps this from contradicting a bare read that really is a column.
 */
function qualifies(ctx: StatementContext, key: string, e: NameEvidence): boolean {
  if (e.into.size > 0) return true;
  if (e.set.size === 0 || e.reads.size === 0) return false;
  const census = ctx.catalog.index(CENSUS, (tables) => columnTypeCensus(ctx.dialect, tables));
  return !census.has(key);
}

export const undeclaredVariable: Rule = {
  id: "routine/undeclared-variable",
  group: "routine",
  severity: "error",
  scope: "statement",
  supersedes: ["names/unqualified-column"],
  docs: `A local used as though a \`DECLARE\` had named it — a \`SET\` target, or a \`SELECT\`/\`FETCH …
INTO\` destination — that no \`DECLARE\` in the enclosing routine or trigger actually does.

An \`INTO\` can only ever name a variable, never a column, so one that nothing declares is never
ambiguous: the server refuses to create the routine over it, error 1327. A \`SET\` that opens a
statement of its own — as opposed to the \`SET\` clause of an \`UPDATE\` or an \`INSERT\` — is read the
same way: the server resolves a name it does not recognise there as a system variable, and there
being no such variable is again refused at \`CREATE\`, error 1193. MySQL and MariaDB agree on both.

**This displaces \`names/unqualified-column\`** on the same tokens. That rule used to be the only
thing sqldex said here, and it said it in two wrong ways at once: "unknown column" on something that
was never meant as a column, when the statement happened to have a resolved table in it — and nothing
at all when it did not, which a bare \`SET\` or \`IF\` inside procedural code usually does not.

**A \`SET\` alone is not enough, deliberately.** \`SET autocommit = 0\` and \`SET sql_mode = '...'\` are
ordinary system-variable writes, and there is no list of system variables this rule is ever going to
grow. Only a name that is also *read* somewhere in the same body — as a value, never as another
write — earns a finding: a write nobody reads back is what most such assignments look like, and is a
different rule's business once the name really is declared.

**Nor is a name any table in the schema happens to have as a column.** Read bare it would be
genuinely ambiguous between the two, and this only reports what cannot be a column at all.

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

    for (let i = ctx.statement.from; i <= ctx.statement.to; i++) {
      const token = ctx.tokens[i];
      if (!token || token.t !== "id") continue;

      const key = ctx.dialect.foldIdentifier(token.v, token.q === true);
      const e = evidence.get(key);
      if (!e || !qualifies(ctx, key, e)) continue;

      if (e.into.has(i) || e.set.has(i)) {
        ctx.report(token, `${token.v} is not declared`);
        continue;
      }
      if (!e.reads.has(i) || !readsAreSafe) continue;

      outputAliases ??= selectOutputAliases(ctx);
      ctes ??= cteNames(ctx.dialect, ctx.tokens, ctx.statement.from, ctx.statement.to);
      if (knownBareName(ctx, i, outputAliases, ctes)) continue;

      ctx.report(token, `${token.v} is not declared`);
    }
  },
};
