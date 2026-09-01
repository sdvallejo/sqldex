/**
 * What an install runs, which is not what the suite runs.
 *
 *     npm run build && node tools/check-packaged.ts
 *
 * Every test in this repository executes the TypeScript sources: `cli.test.ts` calls `main()` in
 * process with fake streams, deliberately, so a failure points at a line instead of at a
 * subprocess, and the LSP tests drive the server the same way. Nothing spawns anything, and
 * `--conditions=development` resolves every package to `src/`. A published package is the opposite
 * on both counts — a real process, running the `.js` that `tsc` emitted — and the difference is not
 * theoretical: `0.9.1` and `0.9.2` shipped a syntax check that could not start at all, because both
 * the CLI's worker pool and the LSP's checker named their worker by its `.ts` source filename,
 * which no install has. The suite was green throughout.
 *
 * So this is the one check that refuses to look at `src/`. It spawns the built CLI and the built
 * language server as an installed copy would, over the fixture the suite already uses for a real
 * MySQL syntax error, and asks each for the finding only a working worker can produce.
 *
 * **Both halves, not one.** The two packages carry separate copies of the same worker-spawning
 * decision, and they fail differently: the CLI hung forever, while the language server simply went
 * quiet — the harder of the two to notice, and the one an editor user actually meets. A check that
 * covered only the CLI would leave the quieter failure uncovered.
 *
 * Every wait here is bounded, because the regression this exists to catch is a hang: a check that
 * hangs while proving something does not hang is no check at all.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "packages/cli/dist/main.js");
const SERVER = join(ROOT, "packages/lsp/dist/main.js");
const BROKEN = join(ROOT, "packages/cli/test/fixtures/broken");

/** Generous: this is not a performance budget, it is the line between "slow" and "never". */
const TIMEOUT_MS = 60_000;

interface Finding {
  code: string;
  severity: string;
  message: string;
}

/**
 * `declareProject` is the difference between the two callers, and it is not incidental. The CLI
 * checks the paths it is pointed at; the server refuses to index a directory that does not declare
 * itself a schema project, so without this the server half would prove nothing — it would go quiet
 * for the documented reason rather than the broken one, and pass or fail identically either way.
 * An empty config is the smallest thing that declares one.
 */
function fixture(declareProject = false): string {
  const dir = mkdtempSync(join(tmpdir(), "sqldex-packaged-"));
  cpSync(BROKEN, dir, { recursive: true });
  if (declareProject) writeFileSync(join(dir, ".sqldex.json"), "{}\n");
  return dir;
}

/** The built CLI, as a subprocess, with a bound on how long it may take to say anything. */
async function checkCli(): Promise<void> {
  const cwd = fixture();
  const child = spawn(process.execPath, [CLI, "check", ".", "--format", "json"], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });

  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the packaged CLI produced no answer in ${TIMEOUT_MS / 1000}s — it hung`));
    }, TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });

  assert.equal(code, 1, `expected findings, and the exit code that reports them\n${err}`);
  const report = JSON.parse(out) as { findings: Finding[] };
  const syntax = report.findings.filter((f) => f.code === "sqldex:syntax-error");
  assert.equal(syntax.length, 1, `expected exactly one syntax error, got ${syntax.length}`);
  assert.match(syntax[0]?.message ?? "", /syntax error:/);
  console.log(`  cli    ${syntax[0]?.message}`);
}

/** Minimal LSP client: enough of the protocol to open one file and hear back about it. */
class Server {
  private buffer = Buffer.alloc(0);
  private readonly messages: Record<string, unknown>[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  stderr = "";

  constructor(root: string) {
    this.child = spawn(process.execPath, [SERVER, "--stdio"], { cwd: root });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = this.buffer.subarray(0, headerEnd).toString();
        const length = Number(/content-length: (\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length) || this.buffer.length < headerEnd + 4 + length) return;
        const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
        this.buffer = this.buffer.subarray(headerEnd + 4 + length);
        this.messages.push(JSON.parse(body) as Record<string, unknown>);
      }
    });
  }

  send(message: Record<string, unknown>): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  async waitFor<T extends Record<string, unknown>>(
    predicate: (message: Record<string, unknown>) => boolean,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const hit = this.messages.find(predicate);
      if (hit) return hit as T;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.child.exitCode !== null) break;
    }
    throw new Error(`the packaged server never sent ${what}\n${this.stderr}`);
  }
}

/** The built language server, over stdio, exactly as an editor client starts it. */
async function checkServer(): Promise<void> {
  const root = fixture(true);
  const server = new Server(root);
  const rootUri = pathToFileURL(root).href;

  server.send({
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: "packaged" }],
    },
  });
  await server.waitFor((m) => m.id === 1 && "result" in m, "an initialize result");
  server.send({ method: "initialized", params: {} });

  const path = join(root, "schema.sql");
  const uri = pathToFileURL(path).href;
  server.send({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "sql", version: 1, text: readFileSync(path, "utf8") },
    },
  });

  const push = await server.waitFor<{ params: { diagnostics: Finding[] } }>(
    (m) =>
      m.method === "textDocument/publishDiagnostics" &&
      (m.params as { uri: string; diagnostics: Finding[] }).uri === uri &&
      (m.params as { diagnostics: Finding[] }).diagnostics.some((d) => d.code === "sqldex:syntax-error"),
    "a syntax error for a file that does not parse",
  );
  const syntax = push.params.diagnostics.find((d) => d.code === "sqldex:syntax-error");
  console.log(`  lsp    ${syntax?.message}`);
  server.child.kill();
}

for (const [what, path] of [
  ["the CLI", CLI],
  ["the language server", SERVER],
] as const) {
  if (!existsSync(path)) {
    console.error(`${what} has not been built — run \`npm run build\` first (looked for ${path})`);
    process.exit(2);
  }
}

console.log("checking what a published package actually runs:");
await checkCli();
await checkServer();
console.log("both answer from their built form.");
