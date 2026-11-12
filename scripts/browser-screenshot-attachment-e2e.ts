// Drives Electron BrowserHost, AgentService, the Codex adapter and SQLite with a controlled provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".openbot-build/browser-screenshot-attachment-e2e");
const fixture = await mkdtemp(join(tmpdir(), "openbot-browser-attachment-"));
const runId = randomUUID();
const reportPath = join(out, "report.json");
try {
  await mkdir(out, { recursive: true });
  const entry = join(out, "fixture.mjs");
  await run(process.execPath, [
    "build",
    "scripts/browser-screenshot-attachment-electron.ts",
    "--target=node",
    "--format=esm",
    "--external=electron",
    "--external=quickjs-emscripten-core",
    "--external=@jitl/quickjs-wasmfile-release-sync",
    `--outfile=${entry}`,
  ]);
  await run(
    join(root, "node_modules/.bin/electron"),
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      entry,
      `--fixture-root=${fixture}`,
      `--report-path=${reportPath}`,
      `--run-id=${runId}`,
    ],
    true,
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.runId, runId);
  assert.equal(report.passed, true);
  process.stdout.write(`${JSON.stringify({ passed: true, checks: report.checks, reportPath })}\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

async function run(command: string, args: string[], electron = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: electron ? withoutElectronRuntimeFlags(process.env) : process.env,
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Fixture failed (${code}).`));
    });
  });
}
