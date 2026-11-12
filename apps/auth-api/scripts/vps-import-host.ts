// Operator-only initial import of public host metadata; never imports sessions or private host keys.
import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { createVpsBindings } from "../src/vps/bindings";

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  owner: Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String }),
  host: Schema.Struct({
    hostId: Schema.String,
    ownerMembershipId: Schema.String,
    name: Schema.String,
    devicePublicKey: Schema.String,
  }),
});
async function main() {
  const file = process.argv[2];
  const directory = process.env.OPENBOT_AUTH_STATE_DIRECTORY;
  if (!file || !directory) throw new Error("An import manifest and explicit account state directory are required.");
  const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(await readFile(file, "utf8")));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (![manifest.owner.id, manifest.host.hostId, manifest.host.ownerMembershipId].every((value) => uuid.test(value)))
    throw new Error("Invalid import identifiers.");
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(manifest.owner.email) ||
    manifest.owner.email !== manifest.owner.email.trim().toLowerCase()
  )
    throw new Error("Import email must be normalized.");
  if (!manifest.host.name.trim() || manifest.host.name.length > 120 || manifest.owner.name.length > 120)
    throw new Error("Invalid import names.");
  if (createPublicKey(manifest.host.devicePublicKey).asymmetricKeyType !== "ed25519")
    throw new Error("Import requires the existing public host identity.");
  const resources = await createVpsBindings({
    directory: resolve(directory),
    migrations: resolve(import.meta.dirname, "../migrations"),
    signalUrl: "wss://openbot.harpia.digital/v1/signal",
    webhookUrl: "https://openbot.harpia.digital/internal/auth-events",
    environment: {},
  });
  try {
    const db = resources.bindings.DB;
    const existing = await db
      .prepare(
        "SELECT h.owner_user_id,h.device_public_key,u.email,m.membership_id FROM remote_hosts h JOIN users u ON u.id=h.owner_user_id JOIN remote_memberships m ON m.host_id=h.host_id AND m.role='owner' WHERE h.host_id=?",
      )
      .bind(manifest.host.hostId)
      .first();
    if (existing) {
      if (
        existing.owner_user_id !== manifest.owner.id ||
        existing.email !== manifest.owner.email ||
        existing.device_public_key !== manifest.host.devicePublicKey ||
        existing.membership_id !== manifest.host.ownerMembershipId
      )
        throw new Error("Existing account state does not match the import; restore or reconcile explicitly.");
      process.stdout.write(
        `${JSON.stringify({ imported: false, unchanged: true, privateHostKeyImported: false, sessionsImported: false })}\n`,
      );
      return;
    }
    const counts = await db
      .prepare("SELECT (SELECT count(*) FROM users) AS users,(SELECT count(*) FROM remote_hosts) AS hosts")
      .first();
    if (counts?.users !== 0 || counts.hosts !== 0)
      throw new Error("Initial import requires an empty account directory.");
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO users(id,identity_key,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)",
        )
        .bind(manifest.owner.id, `email:${manifest.owner.email}`, manifest.owner.email, manifest.owner.name, now, now),
      db
        .prepare(
          "INSERT INTO remote_hosts(host_id,owner_user_id,name,device_public_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(manifest.host.hostId, manifest.owner.id, manifest.host.name, manifest.host.devicePublicKey, now, now),
      db
        .prepare(
          "INSERT INTO remote_memberships(membership_id,host_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'owner','active',?,?)",
        )
        .bind(manifest.host.ownerMembershipId, manifest.host.hostId, manifest.owner.id, now, now),
    ]);
    process.stdout.write(
      `${JSON.stringify({ imported: true, ownerCount: 1, hostCount: 1, privateHostKeyImported: false, sessionsImported: false })}\n`,
    );
  } finally {
    resources.close();
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ importFailed: true, type: error instanceof Error ? error.name : "Unknown" })}\n`,
  );
  process.exitCode = 1;
});
