/**
 * Whether this Node can run `sqldex-lsp`, in a file of its own so a test can check the logic without
 * pulling in `main.ts` — that file opens a real connection on `stdio` as a side effect of import.
 */

/** The oldest Node this package is built and tested against — see the root README. */
const NEEDS_NODE = { major: 22, minor: 18 } as const;

/**
 * Why `sqldex-lsp` cannot run on `version`, or `undefined` when it can.
 *
 * A Node this old does not fail to parse `dist/`, which is plain compiled JavaScript — it fails
 * later and unrelated-looking, the first time a request handler calls a method the runtime does not
 * have, on stdio with no terminal to print a stack trace to. Checking up front trades that for a
 * sentence the client's own output channel can show, the same trade the VS Code extension and the
 * Neovim client already make when they run the server from a checkout instead of this binary.
 */
export function nodeTooOld(version: string): string | undefined {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  if (major > NEEDS_NODE.major || (major === NEEDS_NODE.major && minor >= NEEDS_NODE.minor)) return undefined;
  return `sqldex-lsp needs node ${NEEDS_NODE.major}.${NEEDS_NODE.minor} or newer; ${version} was found.`;
}
