// Runs the operator host import in a child Bun process against a temporary account database.
// Run: bun apps/auth-api/scripts/vps-import-host-e2e.ts
// It writes .openbot-build/vps-import-host-e2e/report.json.

import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { openVpsSqliteDatabase } from "../src/vps/sqlite-database";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "apps/auth-api/scripts/vps-import-host.ts");
const OUT = join(ROOT, ".openbot-build/vps-import-host-e2e");
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const CliResponse = Schema.Union([
  Schema.Struct({
    imported: Schema.Literal(true),
    ownerCount: Schema.Literal(1),
    hostCount: Schema.Literal(1),
    privateHostKeyImported: Schema.Literal(false),
    sessionsImported: Schema.Literal(false),
  }),
  Schema.Struct({
    imported: Schema.Literal(false),
    unchanged: Schema.Literal(true),
    privateHostKeyImported: Schema.Literal(false),
    sessionsImported: Schema.Literal(false),
  }),
  Schema.Struct({ importFailed: Schema.Literal(true), type: Schema.String }),
]);

function check(name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

function publicKey(): string {
  const pair = generateKeyPairSync("ed25519");
  return pair.publicKey.export({ type: "spki", format: "pem" }).toString();
}

function runImport(stateDirectory: string, manifestPath: string) {
  const child = spawnSync(process.execPath, [CLI, manifestPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", OPENBOT_AUTH_STATE_DIRECTORY: stateDirectory },
  });
  if (child.error) throw child.error;
  const output = child.status === 0 ? child.stdout : child.stderr;
  const line = output.trim().split("\n").at(-1) ?? "";
  let response: typeof CliResponse.Type | null = null;
  try {
    response = Schema.decodeUnknownSync(CliResponse)(JSON.parse(line));
  } catch {
    // The report retains only whether the CLI returned a valid result, not raw child output.
  }
  return { status: child.status, response };
}

function responseKind(response: typeof CliResponse.Type | null): "imported" | "unchanged" | "failed" | null {
  if (!response) return null;
  if ("importFailed" in response) return "failed";
  return response.imported ? "imported" : "unchanged";
}

function reportsNoSessionOrPrivateKey(response: typeof CliResponse.Type | null): boolean {
  return (
    response !== null &&
    "privateHostKeyImported" in response &&
    response.privateHostKeyImported === false &&
    response.sessionsImported === false
  );
}

async function databaseState(path: string) {
  const database = await openVpsSqliteDatabase(path);
  try {
    const user = await database
      .prepare("SELECT id, email, name FROM users ORDER BY id LIMIT 1")
      .first<{ id: string; email: string; name: string }>();
    const host = await database
      .prepare("SELECT host_id, owner_user_id, name, device_public_key FROM remote_hosts ORDER BY host_id LIMIT 1")
      .first<{ host_id: string; owner_user_id: string; name: string; device_public_key: string }>();
    const membership = await database
      .prepare(
        "SELECT membership_id, host_id, user_id, role, status FROM remote_memberships ORDER BY membership_id LIMIT 1",
      )
      .first<{ membership_id: string; host_id: string; user_id: string; role: string; status: string }>();
    const sessions = await database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM auth_sessions) AS auth,
                (SELECT COUNT(*) FROM remote_sessions) AS remote,
                (SELECT COUNT(*) FROM mobile_auth_sessions) AS mobile`,
      )
      .first<{ auth: number; remote: number; mobile: number }>();
    const counts = await database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM users) AS users,
                (SELECT COUNT(*) FROM remote_hosts) AS hosts,
                (SELECT COUNT(*) FROM remote_memberships) AS memberships`,
      )
      .first<{ users: number; hosts: number; memberships: number }>();
    return { user, host, membership, sessions, counts };
  } finally {
    database.close();
  }
}

async function run(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "vps-import-host-e2e-"));
  const stateDirectory = join(temporary, "state");
  const manifestPath = join(temporary, "host-import.json");
  const statePath = join(stateDirectory, "accounts.sqlite");

  try {
    const manifest = {
      version: 1,
      owner: { id: randomUUID(), email: "host-owner@example.test", name: "Fixture Owner" },
      host: {
        hostId: randomUUID(),
        ownerMembershipId: randomUUID(),
        name: "Fixture Host",
        devicePublicKey: publicKey(),
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

    const imported = runImport(stateDirectory, manifestPath);
    const initial = await databaseState(statePath);
    check(
      "real CLI imports the owner and existing public host identity",
      imported.status === 0 &&
        responseKind(imported.response) === "imported" &&
        initial.user?.id === manifest.owner.id &&
        initial.user.email === manifest.owner.email &&
        initial.user.name === manifest.owner.name &&
        initial.host?.host_id === manifest.host.hostId &&
        initial.host.owner_user_id === manifest.owner.id &&
        initial.host.device_public_key === manifest.host.devicePublicKey &&
        initial.membership?.membership_id === manifest.host.ownerMembershipId &&
        initial.membership.host_id === manifest.host.hostId &&
        initial.membership.user_id === manifest.owner.id &&
        initial.membership.role === "owner" &&
        initial.membership.status === "active" &&
        initial.counts?.users === 1 &&
        initial.counts.hosts === 1 &&
        initial.counts.memberships === 1,
      { status: imported.status, counts: initial.counts },
    );
    check(
      "CLI result explicitly excludes private host keys and sessions",
      reportsNoSessionOrPrivateKey(imported.response) &&
        initial.sessions?.auth === 0 &&
        initial.sessions.remote === 0 &&
        initial.sessions.mobile === 0,
      { sessions: initial.sessions },
    );

    const repeated = runImport(stateDirectory, manifestPath);
    const afterRepeat = await databaseState(statePath);
    check(
      "same manifest is idempotent and leaves imported state unchanged",
      repeated.status === 0 &&
        responseKind(repeated.response) === "unchanged" &&
        JSON.stringify(afterRepeat) === JSON.stringify(initial),
      { status: repeated.status, counts: afterRepeat.counts },
    );

    const mismatchedKeyManifest = {
      ...manifest,
      host: { ...manifest.host, devicePublicKey: publicKey() },
    };
    await writeFile(manifestPath, `${JSON.stringify(mismatchedKeyManifest)}\n`, { mode: 0o600 });
    const mismatchedKey = runImport(stateDirectory, manifestPath);
    const afterMismatch = await databaseState(statePath);
    check(
      "mismatched public key is refused without changing existing data",
      mismatchedKey.status !== 0 &&
        responseKind(mismatchedKey.response) === "failed" &&
        JSON.stringify(afterMismatch) === JSON.stringify(initial),
      { status: mismatchedKey.status, counts: afterMismatch.counts },
    );

    const otherHostManifest = {
      ...manifest,
      host: { ...manifest.host, hostId: randomUUID(), ownerMembershipId: randomUUID() },
    };
    await writeFile(manifestPath, `${JSON.stringify(otherHostManifest)}\n`, { mode: 0o600 });
    const nonemptyTarget = runImport(stateDirectory, manifestPath);
    const afterNonemptyRefusal = await databaseState(statePath);
    check(
      "nonempty target refuses an unrelated initial import without data loss",
      nonemptyTarget.status !== 0 &&
        responseKind(nonemptyTarget.response) === "failed" &&
        JSON.stringify(afterNonemptyRefusal) === JSON.stringify(initial),
      { status: nonemptyTarget.status, counts: afterNonemptyRefusal.counts },
    );
  } catch (error) {
    check("host import E2E completes", false, error instanceof Error ? error.name : "Unknown");
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await writeFile(
      join(OUT, "report.json"),
      `${JSON.stringify({ finishedAt: new Date().toISOString(), checks }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  const failures = checks.filter((entry) => !entry.passed);
  process.stdout.write(`${failures.length ? "FAIL" : "PASS"} VPS host import E2E (${checks.length} checks)\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void run();
