/*
 * Copyright © 2025, Oracle and/or its affiliates
 */

/* eslint-disable no-underscore-dangle */
/* cspell: ignore antlr, longlong, ULONGLONG, MAXDB */

/**
 * SQL modes that control parsing behavior.
 *
 * A `const` object standing in for the original `enum` — sqldex's `erasableSyntaxOnly` forbids a
 * real `enum` (it isn't erasable: the compiler has to emit an object for it), so this is patched by
 * hand after each regeneration. Same member names, same auto-incremented values, same
 * `SqlMode.AnsiQuotes` / `Set<SqlMode>` usage at every call site — nothing downstream changes.
 */
const SqlMode = {
	NoMode: 0,
	AnsiQuotes: 1,
	HighNotPrecedence: 2,
	PipesAsConcat: 3,
	IgnoreSpace: 4,
	NoBackslashEscapes: 5,
} as const;
type SqlMode = (typeof SqlMode)[keyof typeof SqlMode];

export default SqlMode;
