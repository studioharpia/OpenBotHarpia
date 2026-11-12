// Local packages need a certificate-backed identity: ad hoc signing ties privacy grants to a build hash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePackageBin } from "./package-bin";

assert(process.platform === "darwin", "Local macOS packaging requires macOS.");
const args = process.argv.slice(2);
assert(
  args.every((arg) => arg === "--check" || arg === "--artifacts"),
  "Use --check or --artifacts.",
);
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".openbot-build/local-signing");
function command(file: string, argv: string[]): string {
  const result = spawnSync(file, argv, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}
const identities = [
  ...command("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]).matchAll(
    /^\s*\d+\) ([A-F0-9]{40}) "((?:Apple Development|Developer ID Application):[^"\n]+)"/gm,
  ),
].map((match) => ({ hash: match[1], name: match[2] }));
const requested = process.env.CSC_NAME?.trim();
const candidates = requested
  ? identities.filter((identity) => identity.hash === requested || identity.name?.includes(requested))
  : identities;
assert(
  candidates.length === 1,
  "Select exactly one existing Apple Development or Developer ID Application certificate with CSC_NAME (name or SHA-1). Ad hoc signing is not allowed for local updates.",
);
const identity = candidates[0];
assert(identity?.hash && identity.name);
const teamId = identity.name.match(/\(([A-Z0-9]{10})\)$/)?.[1];
assert(teamId, "Missing Apple signing team identifier.");

// Prove the key is usable and that a changed executable still meets the first build's identity.
// This touches disposable binaries only; it never opens the user's Keychain secrets or installed app.
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "openbot-signing-"));
let expectedRequirement = "";
try {
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  await copyFile("/usr/bin/true", first);
  await copyFile("/usr/bin/false", second);
  for (const binary of [first, second]) {
    command("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity.hash,
      "--identifier",
      "app.openbot.desktop",
      "--options",
      "runtime",
      "--timestamp=none",
      binary,
    ]);
    command("/usr/bin/codesign", ["--verify", "--strict", binary]);
  }
  const requirement = (binary: string) => {
    const line = command("/usr/bin/codesign", ["--display", "--requirements", "-", binary])
      .split("\n")
      .find((line) => line.startsWith("designated => "));
    assert(line, "Missing designated requirement.");
    return line.slice("designated => ".length);
  };
  const firstRequirement = requirement(first);
  assert(!firstRequirement.includes("cdhash"), "Identity must not be tied to a build hash.");
  command("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple generic", first]);
  expectedRequirement = firstRequirement;
  assert.equal(requirement(second), firstRequirement);
  command("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${firstRequirement}`, second]);
  await writeFile(
    join(output, "report.json"),
    `${JSON.stringify({ passed: true, certificateSha1: identity.hash, requirement: firstRequirement, verified: ["Two different signed executables", "Same designated requirement", "Second executable satisfies first executable's requirement"], installedAppModified: false, limits: "Signing continuity only; native privacy/Keychain prompts must be checked after the final authorized installation." }, null, 2)}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write(`Stable signing verified. Report: ${join(output, "report.json")}\n`);
if (!args.includes("--check")) {
  const result = spawnSync(
    resolvePackageBin(root, "electron-builder"),
    [
      ...(args.includes("--artifacts") ? [] : ["--dir"]),
      "--mac",
      "--publish",
      "never",
      `--config.mac.identity=${identity.hash}`,
      "--config.mac.notarize=false",
      // Local updates keep the certificate identity without serial remote timestamp requests.
      "--config.mac.timestamp=none",
      `--config.mac.extendInfo.ElectronTeamID=${teamId}`,
      "--config.forceCodeSigning=true",
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, CSC_NAME: identity.hash } },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const appPath = resolve(root, process.arch === "arm64" ? "dist/mac-arm64/OpenBot.app" : "dist/mac/OpenBot.app");
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    command("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${expectedRequirement}`, appPath]);
  }
}
