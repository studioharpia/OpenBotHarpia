// Exercises the real account control plane on the persistent SQLite adapter used by the VPS runtime.
// It applies the checked-in Worker migrations, fills a host to ten active members, checks the
// eleventh is refused, exercises revoke/reactivate, and reopens the same database file.
//
// Run: bun apps/auth-api/scripts/vps-sqlite-e2e.ts
// It writes .openbot-build/vps-sqlite-e2e/report.json and exits non-zero on a failure.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { RemoteControlPlane } from "../src/server/remote-control-plane";
import type { AuthUser } from "../src/server/types";
import { applyVpsMigrations, openVpsSqliteDatabase, type VpsSqliteDatabase } from "../src/vps/sqlite-database";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build", "vps-sqlite-e2e");
const MIGRATIONS = join(ROOT, "apps", "auth-api", "migrations");
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];

function check(name: string, passed: boolean, detail?: unknown): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

async function ticketKeys(): Promise<Record<string, string>> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const kid = `vps-${randomUUID()}`;
  return {
    REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid }),
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid }] }),
    REMOTE_TICKET_KEY_ID: kid,
  };
}

async function createControlPlane(database: VpsSqliteDatabase, now: () => number): Promise<RemoteControlPlane> {
  return new RemoteControlPlane(
    { DB: database, ...(await ticketKeys()) },
    { now, schedule: () => undefined, fetch: async () => new Response(null, { status: 200 }) },
  );
}

function user(name: string): AuthUser {
  const email = `${name}@example.test`;
  return {
    id: randomUUID(),
    email,
    name,
    avatarUrl: null,
    analyticsEnabled: null,
    chatColor: null,
  };
}

async function failureCode<A>(operation: Effect.Effect<A, object>): Promise<string | null> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (result._tag === "Success") return null;
  return "code" in result.failure ? String(result.failure.code) : result.failure.constructor.name;
}

async function activeCount(database: VpsSqliteDatabase, hostId: string): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM remote_memberships WHERE host_id = ? AND status = 'active'")
    .bind(hostId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function allocatedSize(database: VpsSqliteDatabase): Promise<number> {
  const pageCount = await database.prepare("PRAGMA page_count").first<{ page_count: number }>();
  const pageSize = await database.prepare("PRAGMA page_size").first<{ page_size: number }>();
  if (!pageCount || !pageSize) throw new Error("SQLite did not return database page metrics.");
  return Number(pageCount.page_count) * Number(pageSize.page_size);
}

async function insertUser(database: VpsSqliteDatabase, person: AuthUser, now: number): Promise<void> {
  await database
    .prepare(
      `INSERT INTO users(id, identity_key, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(person.id, `email:${person.email}`, person.email, person.name, now, now)
    .run();
}

async function run(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vps-sqlite-e2e-"));
  const databasePath = join(temporaryRoot, "account.sqlite");
  let database: VpsSqliteDatabase | null = null;
  const startedAt = new Date().toISOString();
  const hostId = randomUUID();
  const owner = user("owner");
  const members = Array.from({ length: 10 }, (_, index) => user(`member-${index + 1}`));
  let now = Date.now();
  const tick = () => {
    now += 1_000;
    return now;
  };

  try {
    database = await openVpsSqliteDatabase(databasePath);
    const migrations = await applyVpsMigrations(database, MIGRATIONS);
    check("all existing migrations apply in order", migrations.length > 0, {
      newlyApplied: migrations.length,
      latest: migrations.at(-1),
    });
    const reapplied = await applyVpsMigrations(database, MIGRATIONS);
    check("reopening migration runner applies no migration twice", reapplied.length === 0, { reapplied });

    const binarySource = Uint8Array.from([3, 8, 13, 21]);
    const binaryRead = database.prepare("SELECT ? AS payload").bind(binarySource);
    binarySource.fill(99);
    const binaryResult = await binaryRead.first<{ payload: Uint8Array }>();
    check(
      "bound bytes are snapshotted at bind time",
      binaryResult !== null && Array.from(binaryResult.payload).join(",") === "3,8,13,21",
      {
        payload: binaryResult?.payload ? Array.from(binaryResult.payload) : null,
      },
    );

    const createSizeProbe = await database.prepare("CREATE TABLE vps_e2e_size_probe(payload TEXT NOT NULL)").run();
    check(
      "size_after reports allocated SQLite bytes after schema change",
      createSizeProbe.meta.size_after === (await allocatedSize(database)),
      { reported: createSizeProbe.meta.size_after, actual: await allocatedSize(database) },
    );
    const sizeBeforeInsert = await allocatedSize(database);
    const insertedSizeProbe = await database
      .prepare("INSERT INTO vps_e2e_size_probe(payload) VALUES (?)")
      .bind("x".repeat(32_768))
      .run();
    const actualSizeAfterInsert = await allocatedSize(database);
    check(
      "size_after tracks database growth after a large write",
      insertedSizeProbe.meta.size_after === actualSizeAfterInsert && actualSizeAfterInsert > sizeBeforeInsert,
      {
        before: sizeBeforeInsert,
        reported: insertedSizeProbe.meta.size_after,
        actual: actualSizeAfterInsert,
      },
    );

    await insertUser(database, owner, now);
    for (const person of members) await insertUser(database, person, now);
    await database
      .prepare(
        `INSERT INTO remote_hosts(host_id, owner_user_id, name, created_at, updated_at)
         VALUES (?, ?, 'VPS E2E', ?, ?)`,
      )
      .bind(hostId, owner.id, now, now)
      .run();
    const ownerMembershipId = randomUUID();
    await database
      .prepare(
        `INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
      )
      .bind(ownerMembershipId, hostId, owner.id, now, now)
      .run();

    let plane = await createControlPlane(database, () => now);
    const limit = (await Effect.runPromise(plane.listHosts(owner.id)))[0]?.memberLimit;
    check("a host without plan or license advertises ten seats including the owner", limit === 10, { limit });
    const invite = await Effect.runPromise(plane.createInvite(owner, { hostId, role: "member", permanent: true }));
    for (const person of members.slice(0, 9)) {
      const code = await failureCode(plane.acceptInvite(person, invite.token));
      check(`${person.name} joins within the ten-member limit`, code === null, {
        code,
        active: await activeCount(database, hostId),
      });
    }
    check("owner and nine members fill ten seats", (await activeCount(database, hostId)) === 10, {
      active: await activeCount(database, hostId),
    });

    const eleventh = members[9];
    if (!eleventh) throw new Error("The eleventh user fixture is missing.");
    const fullCode = await failureCode(plane.acceptInvite(eleventh, invite.token));
    check("an eleventh user is refused at the full host", fullCode === "member_limit_reached", {
      code: fullCode,
      active: await activeCount(database, hostId),
    });

    const firstMembership = await database
      .prepare("SELECT membership_id FROM remote_memberships WHERE host_id = ? AND user_id = ?")
      .bind(hostId, members[0]?.id)
      .first<{ membership_id: string }>();
    if (!firstMembership) throw new Error("The first member membership was not stored.");
    tick();
    await Effect.runPromise(
      plane.changeMembership(owner.id, { hostId, membershipId: firstMembership.membership_id, revoke: true }),
    );
    check("revoking a member frees one seat", (await activeCount(database, hostId)) === 9, {
      active: await activeCount(database, hostId),
    });

    tick();
    const replacementCode = await failureCode(plane.acceptInvite(eleventh, invite.token));
    check("the refused invite can join after a seat is freed", replacementCode === null, {
      code: replacementCode,
      active: await activeCount(database, hostId),
    });
    tick();
    const reactivationAtFull = await failureCode(
      plane.changeMembership(owner.id, {
        hostId,
        membershipId: firstMembership.membership_id,
        role: "member",
        reactivate: true,
      }),
    );
    check("reactivation refuses a full host", reactivationAtFull === "member_limit_reached", {
      code: reactivationAtFull,
      active: await activeCount(database, hostId),
    });

    const replacementMembership = await database
      .prepare("SELECT membership_id FROM remote_memberships WHERE host_id = ? AND user_id = ?")
      .bind(hostId, eleventh.id)
      .first<{ membership_id: string }>();
    if (!replacementMembership) throw new Error("The replacement membership was not stored.");
    tick();
    await Effect.runPromise(
      plane.changeMembership(owner.id, {
        hostId,
        membershipId: replacementMembership.membership_id,
        revoke: true,
      }),
    );
    tick();
    const reactivationCode = await failureCode(
      plane.changeMembership(owner.id, {
        hostId,
        membershipId: firstMembership.membership_id,
        role: "member",
        reactivate: true,
      }),
    );
    check("reactivation succeeds after another seat is freed", reactivationCode === null, {
      code: reactivationCode,
      active: await activeCount(database, hostId),
    });

    database.close();
    database = await openVpsSqliteDatabase(databasePath);
    const afterRestartMigrations = await applyVpsMigrations(database, MIGRATIONS);
    plane = await createControlPlane(database, () => now);
    const hosts = await Effect.runPromise(plane.listHosts(owner.id));
    check("migrations and host membership survive database reopen", afterRestartMigrations.length === 0, {
      pendingMigrations: afterRestartMigrations,
      active: await activeCount(database, hostId),
      listedLimit: hosts.find((host) => host.hostId === hostId)?.memberLimit,
    });
    check(
      "reopened host still has ten active members",
      (await activeCount(database, hostId)) === 10 && hosts.find((host) => host.hostId === hostId)?.memberLimit === 10,
      {
        active: await activeCount(database, hostId),
        memberLimit: hosts.find((host) => host.hostId === hostId)?.memberLimit,
      },
    );
  } catch (error) {
    check("E2E runner completes", false, error instanceof Error ? error.message : String(error));
  } finally {
    database?.close();
    await writeFile(
      join(OUT, "report.json"),
      `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), checks }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const failures = checks.filter((entry) => !entry.passed);
  process.stdout.write(`${failures.length ? "FAIL" : "PASS"} VPS SQLite E2E (${checks.length} checks)\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void run();
