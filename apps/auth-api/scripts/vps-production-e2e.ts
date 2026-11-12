// Operator-run production check. Requires explicit --allow-mutations and the live account state directory.
// It creates only synthetic example.test users, sessions, a host and an invitation, then deletes them.
// Run on the VPS from the checkout mounted at /app:
// bun apps/auth-api/scripts/vps-production-e2e.ts --allow-mutations --origin https://openbot.harpia.digital
// It writes .openbot-build/vps-production-e2e/report.json with statuses only.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createOpenBotInviteUrl,
  createWebAppInvitePath,
  inviteUrlFromWebAppSearch,
  parseInviteUrl,
} from "@openbot/contracts/invite-links";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { decodeSignalServerMessage } from "@openbot/contracts/signal-protocol/decode";
import { SIGNAL_PROTOCOL_VERSION } from "@openbot/contracts/signal-protocol/messages";
import { Schema } from "effect";
import { openVpsSqliteDatabase, type VpsSqliteDatabase } from "../src/vps/sqlite-database";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build/vps-production-e2e");
const EXPECTED_ORIGIN = "https://openbot.harpia.digital";
const SESSION_TTL_MS = 10 * 60_000;
const IDENTITY = Schema.Struct({
  version: Schema.Literal(1),
  keyId: Schema.String,
  privateJwk: Schema.String,
  publicJwks: Schema.String,
  webhookSecret: Schema.String,
});
const User = Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.String });
const HostRegistration = Schema.Struct({
  hostId: Schema.String,
  membershipId: Schema.String,
  machineToken: Schema.String,
});
const Invitation = Schema.Struct({ token: Schema.String });
const Membership = Schema.Struct({ membershipId: Schema.String });
const HostDirectory = Schema.Struct({
  hosts: Schema.Array(Schema.Struct({ hostId: Schema.String, memberLimit: Schema.Number })),
});
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ membershipId: Schema.String, status: Schema.String })),
});
const RemoteSession = Schema.Struct({ sessionId: Schema.String });
const Ticket = Schema.Struct({ ticket: Schema.String, signalUrl: Schema.String });
const checks: { name: string; passed: boolean; status?: number }[] = [];

interface FixtureActor {
  id: string;
  email: string;
  name: string;
  sessionId: string;
  sessionToken: string;
}

interface RequestBody {
  hostId?: string;
  ownerMembershipId?: string;
  name?: string;
  devicePublicKey?: string;
  role?: string;
  permanent?: boolean;
  token?: string;
  reactivate?: boolean;
  machineToken?: string;
  clientPublicKey?: string;
}

function check(name: string, passed: boolean, status?: number): void {
  checks.push({ name, passed, ...(status === undefined ? {} : { status }) });
}

function requiredOrigin(args: string[]): URL {
  if (!args.includes("--allow-mutations")) throw new Error("--allow-mutations is required.");
  const originIndex = args.indexOf("--origin");
  const value = originIndex >= 0 ? args[originIndex + 1] : undefined;
  if (!value) throw new Error("--origin is required.");
  const origin = new URL(value);
  if (origin.href !== `${EXPECTED_ORIGIN}/` || origin.protocol !== "https:") {
    throw new Error("This production E2E is pinned to the configured HTTPS account origin.");
  }
  const stateDirectory = process.env.OPENBOT_AUTH_STATE_DIRECTORY?.trim();
  if (!stateDirectory) throw new Error("OPENBOT_AUTH_STATE_DIRECTORY is required.");
  return origin;
}

async function apiRequest(
  origin: URL,
  method: string,
  path: string,
  token?: string,
  body?: RequestBody,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (response.status === 204) return { status: response.status, body: null };
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { status: response.status, body: null };
  }
  return {
    status: response.status,
    body: isDynamicRecord(value) ? value : null,
  };
}

function decode<A>(schema: Schema.ConstraintDecoder<A>, value: unknown): A {
  return Schema.decodeUnknownSync(schema)(value);
}

function fixtureActor(role: string, suffix: string): FixtureActor {
  const sessionToken = randomBytes(32).toString("base64url");
  return {
    id: randomUUID(),
    email: `openbot-vps-${role}-${suffix}@example.test`,
    name: `VPS ${role} fixture`,
    sessionId: randomUUID(),
    sessionToken,
  };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function insertActors(database: VpsSqliteDatabase, actors: readonly FixtureActor[]): Promise<void> {
  const now = Date.now();
  const statements = actors.flatMap((actor) => [
    database
      .prepare(
        "INSERT INTO users(id,identity_key,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?, ?,NULL,?,?)",
      )
      .bind(actor.id, `email:${actor.email}`, actor.email, actor.name, now, now),
    database
      .prepare(
        "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,created_at,last_used_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(actor.sessionId, actor.id, tokenHash(actor.sessionToken), now + SESSION_TTL_MS, now, now),
  ]);
  await database.batch(statements);
}

const protectedRowIds = new Map<string, Set<string>>();
async function snapshotHash(database: VpsSqliteDatabase): Promise<string> {
  // A legitimate user can sign in while the operator checks fixtures. Protect preexisting
  // identities and relationships, while allowing new real sessions and operational timestamps.
  const definitions = [
    { table: "users", key: "id", columns: "id,identity_key,email" },
    { table: "remote_hosts", key: "host_id", columns: "host_id,owner_user_id,device_public_key" },
    { table: "remote_memberships", key: "membership_id", columns: "membership_id,host_id,user_id,role,status" },
    { table: "remote_invites", key: "invite_id", columns: "invite_id,host_id,token_hash,created_by_user_id,role" },
    { table: "auth_sessions", key: "id", columns: "id,user_id,token_hash" },
    { table: "remote_sessions", key: "session_id", columns: "session_id,host_id,user_id,membership_id" },
  ];
  const rows = [];
  for (const definition of definitions) {
    const result = await database
      .prepare(`SELECT ${definition.columns} FROM ${definition.table} ORDER BY ${definition.key}`)
      .all<{ [column: string]: string | null }>();
    let ids = protectedRowIds.get(definition.table);
    if (!ids) {
      ids = new Set(
        result.results.map((row) => {
          const id = row[definition.key];
          if (typeof id !== "string") throw new Error("A protected database row has no identity.");
          return id;
        }),
      );
      protectedRowIds.set(definition.table, ids);
    }
    const existingIds = ids;
    rows.push(
      result.results.filter((row) => {
        const id = row[definition.key];
        return typeof id === "string" && existingIds.has(id);
      }),
    );
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function seededOwnerCount(database: VpsSqliteDatabase): Promise<number> {
  const row = await database
    .prepare("SELECT COUNT(*) AS count FROM remote_memberships WHERE role='owner' AND status='active'")
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function activeMembers(
  origin: URL,
  token: string,
  hostId: string,
): Promise<{ status: number; rows: readonly { membershipId: string; status: string }[] }> {
  const result = await apiRequest(origin, "GET", `/v2/remote/hosts/${hostId}/members/`, token);
  if (result.status !== 200) return { status: result.status, rows: [] };
  const members = decode(Members, result.body).members;
  return { status: result.status, rows: members };
}

function connectSignal(signalUrl: string, ticket: string, peer: "host" | "client") {
  const socket = new WebSocket(signalUrl);
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  let resolveReady: (result: { ready: boolean; errorCode?: string }) => void = () => undefined;
  const ready = new Promise<{ ready: boolean; errorCode?: string }>((resolveReadyPromise) => {
    resolveReady = resolveReadyPromise;
  });
  const settle = (result: { ready: boolean; errorCode?: string }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveReady(result);
  };
  timer = setTimeout(() => settle({ ready: false }), 25_000);
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        version: SIGNAL_PROTOCOL_VERSION,
        peer,
        token: ticket,
        ...(peer === "host" ? { multiplex: true } : {}),
      }),
    );
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = decodeSignalServerMessage(JSON.parse(String(event.data)));
      if (message?.type === "ready") settle({ ready: true });
      else if (message?.type === "error") settle({ ready: false, errorCode: message.code });
    } catch {
      settle({ ready: false });
    }
  });
  socket.addEventListener("error", () => settle({ ready: false }));
  socket.addEventListener("close", () => settle({ ready: false }));
  return { socket, ready, close: () => socket.close(1000, "production e2e complete") };
}

async function cleanupFixtures(
  database: VpsSqliteDatabase,
  actors: readonly FixtureActor[],
  hostId: string | null,
): Promise<void> {
  const ids = actors.map((actor) => actor.id);
  const sessionIds = actors.map((actor) => actor.sessionId);
  const placeholders = (values: readonly string[]) => values.map(() => "?").join(",");
  const userClause = ids.length ? `user_id IN (${placeholders(ids)})` : "0";
  const creatorClause = ids.length ? `created_by_user_id IN (${placeholders(ids)})` : "0";
  const userHostBinds = ids;
  const sessionBinds = sessionIds;
  const statements = [];
  if (ids.length) {
    statements.push(
      database
        .prepare(
          `DELETE FROM remote_auth_events
           WHERE json_extract(payload, '$.userId') IN (${placeholders(ids)})${hostId ? " OR json_extract(payload, '$.hostId') = ?" : ""}`,
        )
        .bind(...ids, ...(hostId ? [hostId] : [])),
    );
  }
  if (hostId) {
    statements.push(
      database.prepare(`DELETE FROM remote_sessions WHERE host_id = ? OR ${userClause}`).bind(hostId, ...userHostBinds),
      database
        .prepare(`DELETE FROM remote_invites WHERE host_id = ? OR ${creatorClause}`)
        .bind(hostId, ...userHostBinds),
      database
        .prepare(`DELETE FROM remote_memberships WHERE host_id = ? OR ${userClause}`)
        .bind(hostId, ...userHostBinds),
    );
  } else {
    statements.push(
      database.prepare(`DELETE FROM remote_sessions WHERE ${userClause}`).bind(...userHostBinds),
      database.prepare(`DELETE FROM remote_invites WHERE ${creatorClause}`).bind(...userHostBinds),
      database.prepare(`DELETE FROM remote_memberships WHERE ${userClause}`).bind(...userHostBinds),
    );
  }
  if (hostId && actors[0]) {
    statements.push(
      database.prepare("DELETE FROM remote_hosts WHERE host_id = ? AND owner_user_id = ?").bind(hostId, actors[0].id),
    );
  }
  if (sessionIds.length) {
    statements.push(
      database
        .prepare(
          `DELETE FROM auth_sessions WHERE id IN (${placeholders(sessionIds)}) AND user_id IN (${placeholders(ids)})`,
        )
        .bind(...sessionBinds, ...ids),
    );
    statements.push(
      database
        .prepare(`DELETE FROM users WHERE id IN (${placeholders(ids)}) AND email LIKE '%@example.test'`)
        .bind(...ids),
    );
  }
  if (statements.length) await database.batch(statements);
}

async function fixtureCounts(database: VpsSqliteDatabase, actors: readonly FixtureActor[], hostId: string | null) {
  const ids = actors.map((actor) => actor.id);
  const userPlaceholders = ids.map(() => "?").join(",");
  const hostCount = hostId
    ? await database
        .prepare("SELECT COUNT(*) AS count FROM remote_hosts WHERE host_id = ?")
        .bind(hostId)
        .first<{ count: number }>()
    : { count: 0 };
  const userCount = ids.length
    ? await database
        .prepare(`SELECT COUNT(*) AS count FROM users WHERE id IN (${userPlaceholders})`)
        .bind(...ids)
        .first<{ count: number }>()
    : { count: 0 };
  return { hosts: Number(hostCount?.count ?? 0), users: Number(userCount?.count ?? 0) };
}

async function run(): Promise<void> {
  const origin = requiredOrigin(process.argv.slice(2));
  const configuredDirectory = process.env.OPENBOT_AUTH_STATE_DIRECTORY;
  if (!configuredDirectory) throw new Error("OPENBOT_AUTH_STATE_DIRECTORY is required.");
  const stateDirectory = await realpath(resolve(configuredDirectory));
  const stateInfo = await stat(stateDirectory);
  const databasePath = join(stateDirectory, "accounts.sqlite");
  const databaseInfo = await stat(databasePath);
  if (!stateInfo.isDirectory() || !databaseInfo.isFile() || databaseInfo.size === 0) {
    throw new Error("The configured account state directory does not contain an existing database.");
  }

  await mkdir(OUT, { recursive: true });
  const startedAt = new Date().toISOString();
  const suffix = randomUUID();
  const owner = fixtureActor("owner", suffix);
  const members = Array.from({ length: 10 }, (_, index) => fixtureActor(`member-${index + 1}`, suffix));
  const actors = [owner, ...members];
  const hostId = randomUUID();
  const ownerMembershipId = randomUUID();
  const pair = generateKeyPairSync("ed25519");
  const devicePublicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  let database: VpsSqliteDatabase | null = null;
  let baseline: string | null = null;
  let hostSocket: ReturnType<typeof connectSignal> | null = null;
  let clientSocket: ReturnType<typeof connectSignal> | null = null;
  let remoteSessionId: string | null = null;
  let machineToken: string | null = null;
  let hostCreated = false;
  let failure: string | null = null;

  try {
    database = await openVpsSqliteDatabase(databasePath);
    baseline = await snapshotHash(database);
    const ownersBefore = await seededOwnerCount(database);
    check("preexisting owner host data is present", ownersBefore > 0);
    if (ownersBefore === 0) throw new Error("No preexisting owner row was found; refusing production fixtures.");

    const identity = Schema.decodeUnknownSync(IDENTITY)(
      JSON.parse(await readFile(join(stateDirectory, "identity.secret.json"), "utf8")),
    );
    const healthy = await apiRequest(origin, "GET", "/health/ready");
    check("live HTTPS account API is ready", healthy.status === 200, healthy.status);
    if (healthy.status !== 200) throw new Error("The production account API is not ready.");
    const jwks = await apiRequest(origin, "GET", "/.well-known/jwks.json");
    let sameIdentity = false;
    if (jwks.status === 200 && jwks.body) {
      const localJwks = JSON.parse(identity.publicJwks);
      sameIdentity = JSON.stringify(jwks.body) === JSON.stringify(localJwks);
    }
    check("live API signing key matches the configured VPS state directory", sameIdentity, jwks.status);
    if (!sameIdentity) throw new Error("The live API does not match this VPS account state directory.");

    await insertActors(database, actors);
    const me = await apiRequest(origin, "GET", "/v1/me", owner.sessionToken);
    const meUser = me.status === 200 ? decode(User, me.body) : null;
    check("synthetic owner session authenticates without email or OTP", meUser?.id === owner.id, me.status);

    const registered = await apiRequest(origin, "POST", "/v2/remote/hosts/register", owner.sessionToken, {
      hostId,
      ownerMembershipId,
      name: "VPS production fixture",
      devicePublicKey,
    });
    if (registered.status === 201) {
      hostCreated = true;
      const result = decode(HostRegistration, registered.body);
      machineToken = result.machineToken;
      hostCreated = true;
      check(
        "registration response identifies only the synthetic host",
        result.hostId === hostId && result.membershipId === ownerMembershipId,
        registered.status,
      );
    }
    if (registered.status !== 201) check("API registers only the synthetic test host", false, registered.status);

    const directory = await apiRequest(origin, "GET", "/v2/remote/hosts/", owner.sessionToken);
    const listedHosts = directory.status === 200 ? decode(HostDirectory, directory.body).hosts : [];
    check(
      "owner's host directory reports the ten-member limit",
      listedHosts.find((host) => host.hostId === hostId)?.memberLimit === 10,
      directory.status,
    );

    const createdInvite = await apiRequest(origin, "POST", `/v2/remote/hosts/${hostId}/invites`, owner.sessionToken, {
      role: "member",
      permanent: true,
    });
    const invite = createdInvite.status === 201 ? decode(Invitation, createdInvite.body).token : null;
    check("synthetic owner creates a reusable invite through the API", invite !== null, createdInvite.status);

    if (invite) {
      const fingerprint = createHash("sha256").update(devicePublicKey).digest("base64url");
      const inviteOptions = { selfHostedApiOrigin: origin.origin };
      const desktopLink = createOpenBotInviteUrl(
        { apiUrl: origin.origin, serverId: hostId, fingerprint, token: invite },
        inviteOptions,
      );
      let desktopParses = false;
      try {
        desktopParses = parseInviteUrl(desktopLink, inviteOptions).apiUrl === origin.origin;
      } catch {
        desktopParses = false;
      }
      let rejectsUnconfiguredDomain = false;
      try {
        parseInviteUrl(desktopLink);
      } catch {
        rejectsUnconfiguredDomain = true;
      }
      check(
        "desktop invite parser accepts only its configured self-hosted API origin",
        desktopParses && rejectsUnconfiguredDomain,
      );

      const webPath = createWebAppInvitePath(desktopLink, inviteOptions);
      const webInvite = inviteUrlFromWebAppSearch(new URL(webPath, origin).search, inviteOptions);
      let webParses = false;
      if (webInvite) {
        try {
          webParses = parseInviteUrl(webInvite, inviteOptions).serverId === hostId;
        } catch {
          webParses = false;
        }
      }
      check("web invite parser carries the configured self-hosted API origin", webParses);

      const joinedMemberships: string[] = [];
      for (const actor of members.slice(0, 9)) {
        const accepted = await apiRequest(origin, "POST", "/v2/remote/invites/accept", actor.sessionToken, {
          token: invite,
        });
        let membershipId: string | null = null;
        if (accepted.status === 200) membershipId = decode(Membership, accepted.body).membershipId;
        check(
          `synthetic member ${joinedMemberships.length + 1} joins below the cap`,
          membershipId !== null,
          accepted.status,
        );
        if (!membershipId) throw new Error("A synthetic member could not join through the API.");
        joinedMemberships.push(membershipId);
      }
      const full = await activeMembers(origin, owner.sessionToken, hostId);
      check(
        "owner and nine synthetic members fill exactly ten seats",
        full.status === 200 && full.rows.filter((row) => row.status === "active").length === 10,
        full.status,
      );

      const eleventh = members[9];
      const firstMembershipId = joinedMemberships[0];
      const secondMembershipId = joinedMemberships[1];
      if (!eleventh || !firstMembershipId || !secondMembershipId)
        throw new Error("Synthetic membership fixture is incomplete.");
      const refused = await apiRequest(origin, "POST", "/v2/remote/invites/accept", eleventh.sessionToken, {
        token: invite,
      });
      const refusedCode =
        isDynamicRecord(refused.body) && isDynamicRecord(refused.body.error) ? refused.body.error.code : undefined;
      check(
        "eleventh synthetic member is refused at the real API boundary",
        refused.status === 409 && refusedCode === "member_limit_reached",
        refused.status,
      );

      const revokedFirst = await apiRequest(
        origin,
        "DELETE",
        `/v2/remote/hosts/${hostId}/members/${firstMembershipId}`,
        owner.sessionToken,
      );
      const nineAfterRevoke = await activeMembers(origin, owner.sessionToken, hostId);
      check(
        "revocation frees one seat through the real API",
        revokedFirst.status === 204 && nineAfterRevoke.rows.filter((row) => row.status === "active").length === 9,
        revokedFirst.status,
      );

      const replacement = await apiRequest(origin, "POST", "/v2/remote/invites/accept", eleventh.sessionToken, {
        token: invite,
      });
      check("the refused synthetic invite joins after revocation", replacement.status === 200, replacement.status);
      const refusedReactivation = await apiRequest(
        origin,
        "PATCH",
        `/v2/remote/hosts/${hostId}/members/${firstMembershipId}`,
        owner.sessionToken,
        { role: "member", reactivate: true },
      );
      check(
        "reactivation cannot bypass the full ten-seat cap",
        refusedReactivation.status === 409,
        refusedReactivation.status,
      );

      const revokedSecond = await apiRequest(
        origin,
        "DELETE",
        `/v2/remote/hosts/${hostId}/members/${secondMembershipId}`,
        owner.sessionToken,
      );
      const reactivatedFirst = await apiRequest(
        origin,
        "PATCH",
        `/v2/remote/hosts/${hostId}/members/${firstMembershipId}`,
        owner.sessionToken,
        { role: "member", reactivate: true },
      );
      const finalMembers = await activeMembers(origin, owner.sessionToken, hostId);
      check(
        "reactivation succeeds only after another seat is released",
        revokedSecond.status === 204 &&
          reactivatedFirst.status === 204 &&
          finalMembers.rows.filter((row) => row.status === "active").length === 10,
        reactivatedFirst.status,
      );
    }

    if (hostCreated && machineToken) {
      const hostTicketReply = await apiRequest(origin, "POST", `/v2/remote/hosts/${hostId}/ticket`, undefined, {
        machineToken,
      });
      let hostTicket: typeof Ticket.Type | null = null;
      if (hostTicketReply.status === 200) hostTicket = decode(Ticket, hostTicketReply.body);
      check("host Signal ticket is issued by the production API", hostTicket !== null, hostTicketReply.status);
      if (hostTicket) {
        hostSocket = connectSignal(hostTicket.signalUrl, hostTicket.ticket, "host");
        const hostReady = await hostSocket.ready;
        check("host reaches authenticated Signal ready with API ticket", hostReady.ready);

        const remoteSessionReply = await apiRequest(origin, "POST", "/v2/remote/sessions/", owner.sessionToken, {
          hostId,
        });
        if (remoteSessionReply.status === 201)
          remoteSessionId = decode(RemoteSession, remoteSessionReply.body).sessionId;
        check(
          "client remote session is created for the synthetic owner",
          remoteSessionId !== null,
          remoteSessionReply.status,
        );
        if (remoteSessionId) {
          const clientPair = generateKeyPairSync("ed25519");
          const clientPublicKey = clientPair.publicKey.export({ type: "spki", format: "pem" }).toString();
          const clientTicketReply = await apiRequest(
            origin,
            "POST",
            `/v2/remote/sessions/${remoteSessionId}/ticket`,
            owner.sessionToken,
            { clientPublicKey },
          );
          let clientTicket: typeof Ticket.Type | null = null;
          if (clientTicketReply.status === 200) clientTicket = decode(Ticket, clientTicketReply.body);
          check(
            "client Signal ticket is issued by the production API",
            clientTicket !== null,
            clientTicketReply.status,
          );
          if (clientTicket) {
            clientSocket = connectSignal(clientTicket.signalUrl, clientTicket.ticket, "client");
            const clientReady = await clientSocket.ready;
            check("client reaches authenticated Signal ready with API ticket", clientReady.ready);
          }
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.name : "Unknown";
  } finally {
    clientSocket?.close();
    hostSocket?.close();
    if (remoteSessionId && database) {
      try {
        await apiRequest(origin, "POST", `/v2/remote/sessions/${remoteSessionId}/end`, owner.sessionToken);
      } catch {
        // Direct fixture cleanup below still removes this synthetic session.
      }
    }
    if (database) {
      try {
        await cleanupFixtures(database, actors, hostCreated ? hostId : null);
      } catch {
        checks.push({ name: "synthetic fixture rows clean up without touching existing rows", passed: false });
      }
      const remaining = await fixtureCounts(database, actors, hostCreated ? hostId : null).catch(() => ({
        hosts: 1,
        users: 1,
      }));
      check("synthetic fixture rows are removed from the VPS database", remaining.hosts === 0 && remaining.users === 0);
      const ownerStateIntact = baseline !== null && (await snapshotHash(database).catch(() => "")) === baseline;
      check("preexisting identities, host keys and membership relationships remain intact", ownerStateIntact);
      database.close();
    }
    if (failure) checks.push({ name: "production E2E completes", passed: false });
    const reportPath = join(OUT, "report.json");
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          origin: origin.origin,
          fixtureDomain: "example.test",
          checks,
          failure,
          limits:
            "Signal ready proves API-issued tickets and WSS authentication; it does not complete WebRTC/data-channel authentication or transfer user data.",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await chmod(reportPath, 0o600);
  }

  const passed = checks.length > 0 && checks.every((entry) => entry.passed);
  process.stdout.write(`${passed ? "PASS" : "FAIL"} VPS production E2E (${checks.length} checks)\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (!passed) process.exitCode = 1;
}

void run().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ productionE2eBlocked: true, type: error instanceof Error ? error.name : "Unknown" })}\n`,
  );
  process.exitCode = 1;
});
