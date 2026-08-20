#!/usr/bin/env bash
# Regenerates src/generated/ from antlr/grammars-v4's MySQL grammar.
#
# Manual, maintainer-only, run against a deliberately chosen commit — never run by `npm install`
# and never run automatically. The grammar updates roughly twice a year; bumping
# VENDORED_GRAMMAR_COMMIT is a deliberate act, not something that happens as a side effect of
# anything else.
#
# Needs: git, python3, java (for the antlr4ng-cli generator — see the note below), node/npm.
set -euo pipefail

GRAMMAR_COMMIT="${1:?usage: regenerate.sh <grammars-v4 commit>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(dirname "$HERE")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching antlr/grammars-v4 @ $GRAMMAR_COMMIT ..."
git clone --filter=blob:none --sparse https://github.com/antlr/grammars-v4.git "$WORK/grammars-v4" >/dev/null
git -C "$WORK/grammars-v4" sparse-checkout set sql/mysql/Oracle >/dev/null
git -C "$WORK/grammars-v4" checkout "$GRAMMAR_COMMIT" >/dev/null

BUILD="$WORK/build"
mkdir -p "$BUILD"
GRAMMAR_DIR="$WORK/grammars-v4/sql/mysql/Oracle"
cp "$GRAMMAR_DIR/MySQLLexer.g4" "$GRAMMAR_DIR/MySQLParser.g4" "$BUILD/"
cp "$GRAMMAR_DIR/Antlr4ng/"*.ts "$GRAMMAR_DIR/Antlr4ng/transformGrammar.py" "$BUILD/"

echo "Transforming grammar for the Antlr4ng target ..."
(cd "$BUILD" && python3 transformGrammar.py)

echo "Installing the generator (antlr4ng-cli — deprecated upstream but what grammars-v4's own"
echo "build script for this grammar still uses; antlr-ng is the recommended replacement but was"
echo "not what this package was last generated with, so switching needs its own verification pass)..."
(cd "$BUILD" && npm init -y >/dev/null && npm install antlr4ng-cli antlr4ng typescript >/dev/null)

JAR=$(find "$BUILD/node_modules/antlr4ng-cli" -iname "*.jar" | head -1)
echo "Generating TypeScript with $JAR ..."
(cd "$BUILD" && java -jar "$JAR" -encoding utf-8 -Dlanguage=TypeScript MySQLLexer.g4)
(cd "$BUILD" && java -jar "$JAR" -encoding utf-8 -Dlanguage=TypeScript MySQLParser.g4)

echo "Vendoring into $PKG_ROOT/src/generated ..."
rm -rf "$PKG_ROOT/src/generated"
mkdir -p "$PKG_ROOT/src/generated"
cp "$BUILD"/MySQLLexer.ts "$BUILD"/MySQLParser.ts "$BUILD"/MySQLParserListener.ts \
   "$BUILD"/MySQLLexerBase.ts "$BUILD"/MySQLParserBase.ts "$BUILD"/SqlMode.ts "$BUILD"/SqlModes.ts \
   "$PKG_ROOT/src/generated/"

cat > "$PKG_ROOT/src/generated/VENDORED_GRAMMAR_COMMIT.ts" <<EOF
/**
 * The \`antlr/grammars-v4\` commit \`src/generated/*.ts\` was generated from — \`sql/mysql/Oracle/\`,
 * via \`tools/regenerate.sh\`. Bump only by re-running that script against a newer commit and
 * re-vendoring its output; \`npm install\` never refreshes this.
 */
export const VENDORED_GRAMMAR_COMMIT = "$GRAMMAR_COMMIT";
EOF

cat <<'MSG'

Vendored. Six manual patches are still needed before this typechecks under sqldex's own
tsconfig (strict, verbatimModuleSyntax, erasableSyntaxOnly) — reapply them now:

  1. In every file under src/generated/, every internal `from "./X.js"` specifier needs to become
     `from "./X.ts"` — sqldex's own convention, and Node's runtime module resolution (unlike tsc)
     does not fall back from a `.js` specifier to a same-named `.ts` file. One safe global patch,
     since every such specifier in this folder refers to another file in this same folder:

       for f in src/generated/*.ts; do
         sed -i -E 's#(from "\./[A-Za-z0-9_]*)\.js"#\1.ts"#g' "$f"
       done

  2. src/generated/MySQLParserBase.ts — `import { Parser, TokenStream } from "antlr4ng"` needs
     `TokenStream` marked `import { Parser, type TokenStream } from "antlr4ng"` (verbatimModuleSyntax).

  3. src/generated/MySQLParserListener.ts — the same, for its whole antlr4ng import line: every
     name it imports (`ErrorNode`, `ParseTreeListener`, `ParserRuleContext`, `TerminalNode`) is used
     only in type position in this file, so the whole line becomes
     `import { type ErrorNode, type ParseTreeListener, type ParserRuleContext, type TerminalNode } from "antlr4ng"`.

  4. src/generated/SqlMode.ts — the generated `enum SqlMode { ... }` is not erasable under
     `erasableSyntaxOnly`. Replace it with the `const` object + derived type pattern already
     committed in git history for this file (`git log -p -- src/generated/SqlMode.ts`) — same member
     names, same auto-incremented values (0, 1, 2, ...), so every `SqlMode.AnsiQuotes` /
     `Set<SqlMode>` call site keeps working unchanged.

Run `npm run typecheck` and `node --conditions=development --test packages/syntax-antlr/test/*.test.ts`
after, and diff the vendored files against the previous commit's before committing — a grammar
update can change generated rule/context class names, which is a real, visible break for anything
downstream, not a mechanical no-op.
MSG
