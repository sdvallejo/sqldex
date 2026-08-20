import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSyntax } from "../src/index.ts";

/** Wraps a body in a procedure, the shape every case in this file uses. */
function procedure(...lines: string[]): string {
  return ["CREATE PROCEDURE sp_case(IN p_order int)", "BEGIN", ...lines, "END"].join("\n");
}

// ------------------------------------------------------------------- valid, and stays quiet

test("an empty file parses clean — zero statements is what queries: query* EOF allows", () => {
  // Measured on a real, empty `CREATE VIEW` source, 0 bytes: the terminator check's fallback for
  // "nothing but blanks and comments" used to mean "no terminator found, append one", which turned
  // genuinely empty input into an empty, unparseable `;`.
  assert.deepEqual(checkSyntax(""), []);
  assert.deepEqual(checkSyntax("   \n\n  "), []);
  assert.deepEqual(checkSyntax("-- just a comment\n"), []);
});

test("a plain CREATE TABLE parses clean", () => {
  const src = "CREATE TABLE orders (order_id int NOT NULL, PRIMARY KEY (order_id));";
  assert.deepEqual(checkSyntax(src), []);
});

test("a routine with no trailing terminator — this project's own file-per-routine convention — parses clean", () => {
  // No `;` after the closing END: this is how every routine in the private corpora is stored, one
  // per file, and it is not a MySQL syntax error — the missing-terminator normalisation in check.ts
  // exists for exactly this shape.
  const src = procedure("  SELECT 1;");
  assert.deepEqual(checkSyntax(src), []);
});

test("a cursor declared, opened, fetched and closed parses clean", () => {
  const src = procedure(
    "  DECLARE done INT DEFAULT FALSE;",
    "  DECLARE v_id INT;",
    "  DECLARE c_rows CURSOR FOR SELECT order_id FROM orders;",
    "  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;",
    "  OPEN c_rows;",
    "  read_loop: LOOP",
    "    FETCH c_rows INTO v_id;",
    "    IF done THEN",
    "      LEAVE read_loop;",
    "    END IF;",
    "  END LOOP;",
    "  CLOSE c_rows;",
  );
  assert.deepEqual(checkSyntax(src), []);
});

test("a handler and a SIGNAL, close to the shape of the original bug, parses clean", () => {
  const src = procedure(
    "  DECLARE p_id_a, p_id_b INT;",
    "  IF p_order = 1 THEN",
    "    SET p_id_a = 1;",
    "  ELSE",
    "    SET p_id_b = 1;",
    "  END IF;",
    "  IF p_id_a = 0 AND p_id_b = 0 THEN",
    "    SIGNAL SQLSTATE VALUE '45000' SET MESSAGE_TEXT = 'expired';",
    "  END IF;",
  );
  assert.deepEqual(checkSyntax(src), []);
});

test("a double-quoted string as an ordinary function argument parses clean under the grammar's own default", () => {
  const src = 'SELECT CONCAT("ERROR ", 1);';
  assert.deepEqual(checkSyntax(src), []);
});

test("a double-quoted JSON path argument to ->> or -> now parses clean, rewritten before it reaches the lexer", () => {
  // Turning ANSI_QUOTES off globally makes this shape parse but breaks the far more common one
  // above — `->>`'s grammar rule wants a text-string-literal specifically, but the general
  // expression grammar's double-quoted-string alternative apparently never routes through that same
  // rule, only through the identifier one. That path was tried and reverted.
  // `normaliseJsonPathQuotes` in check.ts fixes this a different way: swapping the outer quote
  // characters to single quotes ahead of parsing, the same length-preserving text-substitution
  // technique the DELIMITER handling uses. MySQL string literals mean the same thing under either
  // quoting style, so this is a real fix, not a guess — and it is what the ordinary shape in the
  // four private corpora actually looks like (`$.foo.bar`, `$[0].x`, never a quote or backslash
  // inside the path).
  assert.deepEqual(checkSyntax('SELECT data->>"$.Autenticador.Activado" FROM sessions;'), []);
  assert.deepEqual(checkSyntax('SELECT data->"$.Autenticador.Dispositivos" FROM sessions;'), []);
});

test("a JSON path containing a quote character is left alone, and stays a known, suppressed gap", () => {
  // `normaliseJsonPathQuotes` deliberately skips a path holding a quote or backslash character,
  // rather than guess how to re-escape it into a single-quoted literal — turning an embedded `'`
  // into a premature string terminator would be a worse failure than the one this exists to fix.
  // Nothing in the four private corpora hits this (every real path measured is plain,
  // `$.foo.bar`-shaped), so this is a synthetic case: `errors.ts`'s `isKnownGrammarGap` is what keeps
  // it quiet, the same as it did for the whole shape before the real fix above existed.
  const src = "SELECT data->>\"$.it's\" FROM sessions;";
  assert.deepEqual(checkSyntax(src), []);
});

test("REPLACE(...) or IF(...) with a charset-introduced literal argument now parses clean", () => {
  // Not a grammar ambiguity — this was first misdiagnosed as one, on the strength of the grammar's
  // own "Function calls with other conflicts" comment (~MySQLParser.g4:3095-3108) and a
  // `PredictionMode.LL` probe that reproduced the identical failure regardless of lookahead. The real
  // cause was on this package's own side: `MySQLLexerBase.checkCharset(text)` decides whether a
  // `_word` token is a charset introducer by looking `text` up in `lexer.charSets`, which the
  // vendored constructor leaves as an **empty** `Set` — so every `_utf8mb4'...'`-style literal lexed
  // as a bare `IDENTIFIER` immediately followed by an unrelated string token, with nothing joining
  // them, which is what broke these two specific reserved-word-as-function-name alternatives.
  // `check.ts` now populates `lexer.charSets` with every MySQL 8.0 charset name (each carrying its
  // required leading underscore — `this.text` at the point `checkCharset` runs is `_utf8mb4`, not
  // `utf8mb4`, so a set built from the bare names silently never matched). With that populated,
  // REPLACE/IF parse a charset-introduced argument exactly as cleanly as every other function
  // already did. Originally found on real generated-column expressions — one nested inside
  // `json_unquote(json_extract(...))`, whose one root failure also cascaded into two unrelated-looking
  // `RESTRICT` errors later in the same `CREATE TABLE` statement, and one a plain `IF(...)` guard on
  // a status flag.
  assert.deepEqual(checkSyntax("SELECT replace(a, _utf8mb4'b', 'c');"), []);
  assert.deepEqual(checkSyntax("SELECT if(a = _utf8mb4'A', b, NULL);"), []);
  // The same functions without a charset introducer were never affected — this was never "REPLACE/IF
  // are broken", only this one specific combination.
  assert.deepEqual(checkSyntax("SELECT replace(a, 'b', 'c');"), []);
  assert.deepEqual(checkSyntax("SELECT if(a = 'A', b, NULL);"), []);
});

test("URL as a bare column name is a confirmed upstream grammar gap, suppressed rather than shown as noise", () => {
  // A plain omission, not a genuine ambiguity, checked against MySQL's own docs rather than left as
  // a guess. dev.mysql.com/doc/refman/8.0/en/keywords.html lists `URL` as added in 8.0.32,
  // **non-reserved** — real MySQL lets it stand unquoted as a column name. This grammar's own
  // `identifierKeywordsUnambiguous` (and its three "ambiguous" siblings, MySQLParser.g4:4657-4764)
  // never list `URL_SYMBOL`, so nothing here can turn it back into a plain identifier — it is only
  // ever `loadSourceType`'s `LOAD DATA ... URL '...'` (MySQLParser.g4:990). Measured: exactly one
  // real hit, a `SET URL = ...` assignment in a stored procedure. Nothing to
  // guard against here on sqldex's side — this is vendored, generated code, and the fix belongs
  // upstream, in a future grammar release — so `isKnownGrammarGap` in `errors.ts` suppresses it
  // rather than showing the user a syntax error they have no way to act on. Worth revisiting if this
  // hit count ever grows: other keywords gated the same way (`{this.isServerVersionGe80200()}?` and
  // later, twelve such gates in this grammar) may have the same gap for whichever later MySQL release
  // made them non-reserved.
  const found = checkSyntax("UPDATE t SET URL = 1 WHERE id = 1;");
  assert.deepEqual(found, [], "update this test if a future grammar vendoring fixes it");
});

test("DELIMITER ;; ahead of two triggers converts both, not just the first", () => {
  // The bug that survived first-pass testing: a single DELIMITER directive stays active for every
  // statement after it, not just the next one. Converting the custom delimiter back to `;` and
  // immediately forgetting it was active left every trigger after the first with its terminator
  // untouched.
  const src = [
    "CREATE TABLE t (id int NOT NULL, PRIMARY KEY (id));",
    "",
    "DELIMITER ;;",
    "CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW",
    "BEGIN",
    "  INSERT INTO log VALUES (1);",
    "END",
    ";;",
    "CREATE TRIGGER t_au AFTER UPDATE ON t FOR EACH ROW",
    "BEGIN",
    "  INSERT INTO log VALUES (2);",
    "END",
    ";;",
    "DELIMITER ;",
    "",
  ].join("\n");
  assert.deepEqual(checkSyntax(src), []);
});

test("DELIMITER $$ glued straight onto END, with no space or newline, still converts", () => {
  const src = [
    "DELIMITER $$",
    "CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW",
    "BEGIN",
    "  INSERT INTO log VALUES (1);",
    "END$$",
    "DELIMITER ;",
    "",
  ].join("\n");
  assert.deepEqual(checkSyntax(src), []);
});

test("a trailing inline comment after the file's real terminator does not read as a missing one", () => {
  // Measured on a real deploy script ending `INSERT INTO … VALUES (…); -- Sistemas` — the line does
  // not literally end with `;`, but it does end with one followed by a comment, and appending a
  // second, empty `;` there is the same defect as the DELIMITER-reset case above, found the same way.
  const src = "INSERT INTO log VALUES (1); -- Sistemas";
  assert.deepEqual(checkSyntax(src), []);
});

test("a DELIMITER reset at end of file does not hide the real terminator two lines earlier", () => {
  // Regression for a narrower version of the same bug: with only one trigger, the final
  // `DELIMITER ;` reset — blanked to a comment — must not make `checkSyntax` think no terminator
  // exists yet and append a redundant, statement-less `;` of its own.
  const src = [
    "CREATE TABLE t (id int NOT NULL, PRIMARY KEY (id));",
    "",
    "DELIMITER ;;",
    "CREATE TRIGGER t_ai AFTER INSERT ON t FOR EACH ROW",
    "BEGIN",
    "  INSERT INTO log VALUES (1);",
    "END",
    ";;",
    "DELIMITER ;",
    "",
  ].join("\n");
  assert.deepEqual(checkSyntax(src), []);
});

// ---------------------------------------------------------------- malformed, and says so

test("a CREATE TABLE with a missing comma between columns is a syntax error", () => {
  const src = "CREATE TABLE foo (\n  id int NOT NULL\n  name varchar(50)\n);";
  const found = checkSyntax(src);
  assert.ok(found.length >= 1, "expected at least one syntax error");
  for (const error of found) {
    assert.ok(error.span.s >= 0 && error.span.e <= src.length + 1);
    assert.ok(error.message.length > 0);
  }
});

test("an unbalanced paren is a syntax error", () => {
  const src = "CREATE TABLE foo (id int NOT NULL, PRIMARY KEY (id);";
  const found = checkSyntax(src);
  assert.ok(found.length >= 1);
});

test("a file of pure garbage is a syntax error, not silence", () => {
  const src = "this is not sql at all !! %%% ((( totally broken\nCREATE TABLE";
  const found = checkSyntax(src);
  assert.ok(found.length >= 1);
});

test("a genuinely truncated routine — not just missing its terminator — is still a syntax error", () => {
  // The normalisation only appends a `;`; it cannot balance a BEGIN that never closes.
  const src = "CREATE PROCEDURE sp_case(IN p_order int)\nBEGIN\n  SELECT 1";
  const found = checkSyntax(src);
  assert.ok(found.length >= 1);
});

test("VENDORED_GRAMMAR_COMMIT is not accidentally blank", async () => {
  const { VENDORED_GRAMMAR_COMMIT } = await import("../src/generated/VENDORED_GRAMMAR_COMMIT.ts");
  assert.ok(VENDORED_GRAMMAR_COMMIT.length > 0);
});
