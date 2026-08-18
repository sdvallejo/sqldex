/**
 * What a rule is, and what it is handed.
 *
 * ## Why an `id` and not a code
 *
 * The obvious design is a short code — `A8`, `B3` — and it is the wrong one. A letter-plus-number
 * scheme has to encode *something* in the letter, and the only candidate is confidence: certain,
 * likely, suggestion. But `severity` already says that, so the letter becomes a second, silently
 * disagreeing answer to the same question, and the number ends up being the order in which the
 * rules were written. What is left is an identifier nobody can read: `sqldex explain A8` requires
 * a lookup table to find out what is even being discussed.
 *
 * So the identity is `group/name`, in kebab-case, and it is the whole identity — there is no
 * parallel numeric code to keep in sync. It appears in `Diagnostic.code`, in `sqldex explain`, in
 * a `-- sqldex:ignore` comment and in a project's config, and it never changes once published.
 *
 * ## What a rule may look at
 *
 * The model, the catalog, and the token stream — through the context it is given, and nothing it
 * fetches for itself. A rule never lexes, never parses and never reads a file.
 *
 * The token stream is in that list on purpose, and it is worth being straight about why, because
 * the tidier promise would be "only the model". Some of these rules ask questions the model has no
 * place to hold an answer to: *is this variable ever read*, *does this name sit inside a
 * `COALESCE`*, *is the same word here a column and there the name of a result*. Those are lexical
 * facts about a body of procedural SQL, and a rule that wants them has to look at tokens. Denying
 * that would mean either a model shaped like a full syntax tree — which is the ANTLR backend, a
 * later phase — or rules that quietly reach around their context, which is worse.
 *
 * So the seam is narrower than "no tokens" and still worth having: what the **schema** rules see is
 * the model, `Table` and `Column` and the catalog, with no token in sight. Those are the rules a
 * different parser would have to keep working, and they are insulated. The lexical rules are
 * coupled to the fast backend by their nature, and saying so is better than a comment that claims
 * otherwise.
 */

import type { Dialect, DialectId } from "../dialects/dialect.ts";
import type { CatalogLookup } from "../catalog/catalog.ts";
import type { DiagnosticTag, Severity } from "../diagnostics.ts";
import type { Locals } from "../model/locals.ts";
import type { Relation } from "../model/query.ts";
import type { Table, Trigger } from "../model/table.ts";
import type { Span, Token, TokenRange } from "../syntax/types.ts";

/**
 * What the rule is *about*, which is what someone turning rules off is choosing between.
 *
 * Not a confidence tier and not an implementation detail: five subjects, each of which a given
 * repo may legitimately not care about.
 */
export type RuleGroup =
  /** The catalog contradicts the code: a name is not there, or it is ambiguous. */
  | "names"
  /** The shape of the DDL: indexes, foreign keys, column types, primary keys. */
  | "schema"
  /** What a statement does: joins, filters, NULL propagation, collations. */
  | "query"
  /** The procedural side: arguments, variables, cursors. */
  | "routine"
  /** The `aud_X` mirror-table convention, which a repo either uses or does not. */
  | "audit";

/**
 * What the rule is handed, one at a time — and therefore what the engine has to compute before
 * calling it.
 *
 * These are the traversals that already have to happen, not a taxonomy invented for the registry:
 * deciding whether a variable is ever read means having seen the whole file, while deciding
 * whether a `JOIN` has a condition means seeing one statement. Splitting them is what lets the
 * engine make **one** pass and share the expensive parts, instead of handing every rule the file
 * and having twenty-six of them walk it.
 */
export type RuleScope =
  /** Once per file. */
  | "document"
  /** Once per non-DDL statement, with its relations already resolved. */
  | "statement"
  /** Once per non-temporary `CREATE TABLE` in the file. */
  | "table"
  /** Once per `CREATE TRIGGER` in the file. */
  | "trigger";

/**
 * What the rules ask of a catalog.
 *
 * The lookups, plus the one thing a rule needs that no single table can answer: how a column name
 * is typed across the whole schema. It is a narrower interface than `Catalog` on purpose — a rule
 * that could reach the file list or the parse errors would be a rule that depends on how the
 * catalog was built.
 */
export interface RuleCatalog extends CatalogLookup {
  columnTypes(): Map<string, Map<string, number>>;
  /** Which tables declare each foreign key name, folded — a name MySQL scopes to the database. */
  constraintNames(): Map<string, string[]>;
}

/** Common to every scope: where we are, and how to say something about it. */
export interface BaseContext {
  readonly dialect: Dialect;
  readonly catalog: RuleCatalog;
  /** The schemas this project defines, folded. A reference outside them is not knowable. */
  readonly schemas: ReadonlySet<string>;
  readonly src: string;
  readonly tokens: readonly Token[];
  /**
   * Everything the enclosing routine declares — parameters, variables, cursors, temporary tables
   * — gathered over the **whole** file rather than up to a point, so a temporary table declared
   * further down does not make a use of it further up look unresolved.
   */
  readonly locals: Locals;
  /**
   * Records a finding. The severity is the rule's, resolved against the config once, so a rule
   * cannot quietly report at two different levels under one `id` — which is what would make
   * `{"rules": {"query/unfiltered-write": "hint"}}` a lie.
   */
  report(at: Span | Token, message: string, tags?: DiagnosticTag[]): void;
}

/**
 * One query scope with the work every rule that uses scopes would otherwise redo.
 *
 * A scope is a finer cut than a statement, and the finer cut is the one that answers "what does
 * this name mean": the `;` bound merges an `IF EXISTS(SELECT … FROM a) THEN UPDATE b` into a single
 * set of relations, which is a different query's worth of names.
 */
export interface ScopeInfo {
  readonly from: number;
  readonly to: number;
  /** Parenthesis depth it opened at. */
  readonly depth: number;
  /** The enclosing scope, which is what a name not found here is looked up in next. */
  readonly parent?: ScopeInfo;
  /** The relations at this scope's own depth, with common table expressions already marked. */
  readonly relations: readonly Relation[];
  /** By folded alias **and** folded name, aliases winning. */
  readonly byAlias: ReadonlyMap<string, Relation>;
}

export interface DocumentContext extends BaseContext {
  /**
   * The file's query scopes, outermost first. Computed on first call and kept, so a document rule
   * that does not need them does not pay for them and two that do only pay once.
   */
  scopes(): readonly ScopeInfo[];
  /** The innermost scope covering a token index, which is where a bare name resolves first. */
  scopeAt(index: number): ScopeInfo | undefined;
  /** The file's statements, on the same terms: computed once, on demand. */
  statements(): readonly TokenRange[];
}

export interface StatementContext extends BaseContext {
  readonly statement: TokenRange;
  readonly relations: readonly Relation[];
  /** By folded alias **and** by folded name, the way a qualifier is looked up. */
  readonly byAlias: ReadonlyMap<string, Relation>;
  /** Those relations that resolved to a real catalog table. */
  readonly resolved: readonly Table[];
  /**
   * Token indexes worth stopping at, found in the engine's single pass over the statement.
   *
   * Without these, every rule that reacts to a `CALL` or an `INSERT` would scan the statement
   * itself and one pass would become a dozen. They are the same three cases the original dispatch
   * loop distinguished, which is not a coincidence: it is the same pass.
   */
  readonly calls: readonly number[];
  readonly inserts: readonly number[];
  /** Index of the `.` in an `id . id`, so both sides are one step away. */
  readonly qualified: readonly number[];
  /**
   * The alias map a qualifier at this token must be read against.
   *
   * The innermost query scope that declares the name, and failing that the statement's own map.
   * The statement map cannot answer what `p` is when the same letter names two different tables in
   * two different queries of one statement — and a `WITH` makes that ordinary. Whichever one a flat
   * map kept, every reference to the other came out as a column that does not exist.
   */
  aliasesFor(index: number, folded: string): ReadonlyMap<string, Relation>;
  /**
   * The innermost query scope covering a token, which is how a statement rule asks whether two
   * things it found are part of the same query.
   *
   * A statement is the wrong bound for that question — one `SET x = (SELECT …) + (SELECT …)` is a
   * single statement holding two unrelated queries — and a rule that used the statement's own
   * relations would happily pair a `SUM` from one with a `JOIN` from the other.
   */
  scopeAt(index: number): ScopeInfo | undefined;
}

export interface TableContext extends BaseContext {
  readonly table: Table;
}

export interface TriggerContext extends BaseContext {
  readonly trigger: Trigger;
}

export type RuleContext = DocumentContext | StatementContext | TableContext | TriggerContext;

interface RuleBase {
  /**
   * Stable identity, `group/name`. Public API: it goes in `Diagnostic.code`, in `explain`, in
   * `-- sqldex:ignore` and in config files, and it does not change once published.
   */
  readonly id: string;
  readonly group: RuleGroup;
  /** The default. A project's config can raise, lower or silence it. */
  readonly severity: Severity;
  /** Absent = every dialect. Present where the rule is about one engine's behaviour. */
  readonly dialects?: readonly DialectId[];
  /**
   * Why the rule exists, in prose, and what it deliberately does not flag.
   *
   * This is published: `sqldex explain` prints it and the rule catalogue is generated from it. It
   * carries the argument, never a measurement of somebody's repo.
   */
  readonly docs: string;
}

/** A rule is its scope plus a `check` that matches it: the pairing is what the union enforces. */
export type Rule =
  | (RuleBase & { readonly scope: "document"; check(ctx: DocumentContext): void })
  | (RuleBase & { readonly scope: "statement"; check(ctx: StatementContext): void })
  | (RuleBase & { readonly scope: "table"; check(ctx: TableContext): void })
  | (RuleBase & { readonly scope: "trigger"; check(ctx: TriggerContext): void });
