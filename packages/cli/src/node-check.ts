/**
 * Whether this Node can run `sqldex`, in a file of its own with no imports of its own — `main.ts`
 * has to run this check *before* it imports anything that pulls in `@sqldex/core`, because an ES
 * module's imports evaluate before its own top-level code does, no matter where in the file the
 * `import` line sits. A dependency-free file is what makes that ordering possible.
 */

/** The oldest Node this package is built and tested against — see the root README. */
const NEEDS_NODE = { major: 22, minor: 18 } as const;

/**
 * Why `sqldex` cannot run on `version`, or `undefined` when it can.
 *
 * A Node this old does not fail to parse `dist/`, which is plain compiled JavaScript — it fails
 * later and unrelated-looking, the moment something imports `@sqldex/core`, which reads the project
 * off disk with `node:fs`'s `globSync` — added in Node 22, so this is not only about the type
 * stripping the root README explains the floor with. Checking up front trades an import-time
 * `SyntaxError` naming an unfamiliar function for a sentence that names the actual cause.
 */
export function nodeTooOld(version: string): string | undefined {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  if (major > NEEDS_NODE.major || (major === NEEDS_NODE.major && minor >= NEEDS_NODE.minor)) return undefined;
  return `sqldex needs node ${NEEDS_NODE.major}.${NEEDS_NODE.minor} or newer; ${version} was found.`;
}
