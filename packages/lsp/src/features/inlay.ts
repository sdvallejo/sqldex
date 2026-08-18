/**
 * `textDocument/inlayHint`.
 *
 * A query with five joins and two-letter aliases reads badly: at line 40 you meet `o.total` and the
 * `FROM … o` that explains it is at line 5. Two hints fix that, and the density of each was measured
 * over a large body of stored procedures before a policy was picked:
 *
 * | Hint | Per line |
 * |---|---|
 * | Column type, one per resolved qualified column | 0.12 |
 * | Alias's table, on **every** use | 0.14 |
 * | Alias's table, on the **first** use per statement | 0.04 |
 *
 * The first and third ship. The second is the same information repeated: once you know `o` is
 * `orders`, saying so twenty more times in the same statement is clutter, and at 0.14 per line it is
 * as dense as the type hints while carrying nothing new.
 *
 * Inlay hints are off by default in most clients, so this is opt-in by construction; each kind can
 * still be turned off on its own.
 */

import {
  collect,
  punct,
  relation as resolveRelation,
  relations,
  statements,
  type Locals,
  type Resolved,
  type Token,
  type TokenRange,
} from "@sqldex/core";
import { InlayHintKind, type InlayHint, type Range } from "vscode-languageserver";

import type { Analysed } from "../documents.ts";
import type { Workspace } from "../workspace.ts";

/** What a qualifier in a statement stands for, and whether saying so is worth a hint. */
interface Standing {
  resolved: Resolved;
  /** A real alias, as opposed to a table referred to by its own name. */
  aliased: boolean;
}

/** What each qualifier in one statement stands for. */
function standingsIn(
  workspace: Workspace,
  scope: Locals,
  tokens: readonly Token[],
  statement: TokenRange,
): Map<string, Standing> {
  const fold = (name: string): string => workspace.dialect.foldIdentifier(name, false);
  const out = new Map<string, Standing>();

  for (const item of relations(workspace.dialect, tokens, statement.from, statement.to)) {
    const key = item.alias !== undefined ? fold(item.alias) : item.name !== undefined ? fold(item.name) : undefined;
    if (key === undefined) continue;

    const resolved = resolveRelation(workspace.resolveContext, scope, item);
    // Every qualifier is recorded, so a column's type is found whether it was reached through an
    // alias or through the table's own name. Only a **real** alias earns the second hint:
    // `FROM customers` needs no note saying that `customers` is `customers`.
    if (resolved) {
      out.set(key, { resolved, aliased: item.alias !== undefined && key !== fold(item.name ?? "") });
    }
  }

  // Inside a trigger, `NEW` and `OLD` are a row of its table, which is worth saying once.
  if (scope.triggerTable !== undefined) {
    const table = workspace.catalog.table(scope.triggerTable);
    if (table) {
      const entry: Standing = { resolved: { kind: "table", table, name: table.name }, aliased: true };
      out.set("new", entry);
      out.set("old", entry);
    }
  }

  return out;
}

/** The hints for a document, within the requested range. */
export function inlayHints(workspace: Workspace, analysed: Analysed, range?: Range): InlayHint[] {
  const settings = workspace.config.inlay_hints;
  if (!settings.column_types && !settings.alias_tables) return [];

  const text = analysed.text;
  const tokens = analysed.lexed.tokens;
  // Collected from the whole file rather than up to a position: a temporary table created below
  // still explains an alias above it, and hints are read, not typed against.
  const scope = collect(workspace.dialect, text, tokens, text.length, analysed.routines);

  const from = range ? analysed.document.offsetAt(range.start) : 0;
  const to = range ? analysed.document.offsetAt(range.end) : text.length;

  const out: InlayHint[] = [];
  for (const statement of statements(tokens)) {
    let standings: Map<string, Standing> | undefined;
    const announced = new Set<string>();

    for (let i = statement.from; i <= statement.to; i++) {
      const qualifierToken = tokens[i - 1];
      const nameToken = tokens[i + 1];
      if (!punct(tokens[i], ".") || qualifierToken?.t !== "id" || nameToken?.t !== "id") continue;
      if (qualifierToken.s < from || nameToken.e > to) continue;

      // Resolved lazily: a statement with no qualified reference in range costs nothing.
      standings ??= standingsIn(workspace, scope, tokens, statement);
      const key = workspace.dialect.foldIdentifier(qualifierToken.v, qualifierToken.q ?? false);
      const entry = standings.get(key);
      if (!entry) continue;

      if (settings.alias_tables && entry.aliased && !announced.has(key)) {
        announced.add(key);
        out.push({
          position: analysed.document.positionAt(qualifierToken.e),
          label: entry.resolved.name,
          // Both kinds describe what something *is*, which is what the parameter kind is not for.
          kind: InlayHintKind.Type,
          paddingLeft: true,
          paddingRight: true,
        });
      }

      if (settings.column_types && entry.resolved.table) {
        const column = entry.resolved.table.byName.get(
          workspace.dialect.foldIdentifier(nameToken.v, nameToken.q ?? false),
        );
        // Nothing is invented for a column the table does not have: that is
        // `names/unknown-column`'s job, and a hint reading `: nil` would be worse than none.
        if (column) {
          out.push({
            position: analysed.document.positionAt(nameToken.e),
            label: `: ${column.type.raw}`,
            kind: InlayHintKind.Type,
          });
        }
      }
    }
  }

  return out;
}
