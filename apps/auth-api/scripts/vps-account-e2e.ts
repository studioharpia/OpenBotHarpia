// Exercises the production-built routes through the standalone HTTP server and persistent SQLite.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { registerSecretValue } from "@openbot/logging";
import { Schema } from "effect";
import { createVpsBindings } from "../src/vps/bindings";
import { startVpsAccountServer } from "../src/vps/http-server";

const ROOT = resolve(import.meta.dirname, "../../..");
const API = join(ROOT, "apps/auth-api");
const OUT = join(ROOT, ".openbot-build/vps-account-e2e");
const SignInStart = Schema.Struct({ challengeId: Schema.String, developmentCode: Schema.String });
const SignIn = Schema.Struct({ sessionToken: Schema.String, user: Schema.Struct({ id: Schema.String }) });
const Invitation = Schema.Struct({ token: Schema.String });
const Membership = Schema.Struct({ membershipId: Schema.String });
const checks: { name: string; passed: boolean; status?: number }[] = [];
function check(name: string, passed: boolean, status?: number) {
  checks.push({ name, passed, ...(status === undefined ? {} : { status }) });
  assert.ok(passed, name);
}

await mkdir(OUT, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "openbot-vps-account-"));
const directory = join(temporary, "state");
const imported = await import(pathToFileURL(join(API, "dist-vps/server/server.js")).href);
assert.equal(typeof imported.default?.fetch, "function", "Build the standalone routes first.");
const entry = imported.default;
const options = {
  directory,
  migrations: join(API, "migrations"),
  signalUrl: "ws://127.0.0.1:9/v1/signal",
  webhookUrl: "http://127.0.0.1:9/internal/auth-events",
  environment: { AUTH_EXPOSE_DEVELOPMENT_CODE: "true" },
};
let resources = await createVpsBindings(options);
async function startIsolatedServer() {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => reservation.close(() => done()));
  return startVpsAccountServer({
    entry,
    bindings: resources.bindings,
    publicOrigin: `http://127.0.0.1:${port}`,
    hostname: "127.0.0.1",
    port,
    assetsDirectory: join(API, "dist-vps/client"),
    scheduled: false,
  });
}
let server = await startIsolatedServer();
let origin = `http://127.0.0.1:${server.port}`;
type AccountTestPayload =
  | { email: string }
  | { challengeId: string; code: string }
  | { hostId: string; ownerMembershipId: string; name: string; devicePublicKey: string }
  | { role: "member"; permanent?: boolean; reactivate?: true }
  | { token: string };
async function request(method: string, path: string, token?: string, body?: AccountTestPayload) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = response.status === 204 ? {} : await response.json();
  assert.ok(isDynamicRecord(value), "The API must return a JSON object.");
  return { status: response.status, body: value };
}
async function signIn(email: string) {
  const started = await request("POST", "/v1/auth/email/start", undefined, { email });
  check("email sign-in starts through the built route", started.status === 200, started.status);
  const challenge = Schema.decodeUnknownSync(SignInStart)(started.body);
  registerSecretValue(challenge.developmentCode, { allowShort: true });
  const verified = await request("POST", "/v1/auth/email/verify", undefined, {
    challengeId: challenge.challengeId,
    code: challenge.developmentCode,
  });
  check("email sign-in verifies through the built route", verified.status === 200, verified.status);
  const actor = Schema.decodeUnknownSync(SignIn)(verified.body);
  registerSecretValue(actor.sessionToken);
  return actor;
}

let failure: string | undefined;
try {
  const health = await request("GET", "/health/ready");
  check("standalone account service is ready without Cloudflare", health.status === 200, health.status);
  const jwks = await request("GET", "/.well-known/jwks.json");
  check(
    "the service publishes its own signing keys",
    jwks.status === 200 && Array.isArray(jwks.body.keys),
    jwks.status,
  );
  const unauthorized = await request("GET", "/v2/remote/hosts/");
  check("host directory requires authentication", unauthorized.status === 401, unauthorized.status);

  // A deliberate import of the local owner's identity into a new service keeps that ID on verified sign-in.
  const ownerId = randomUUID();
  const now = Date.now();
  await resources.bindings.DB.prepare(
    "INSERT INTO users(id,identity_key,email,name,avatar_url,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)",
  )
    .bind(ownerId, "email:owner@vps.example.test", "owner@vps.example.test", "Owner", now, now)
    .run();
  const owner = await signIn("owner@vps.example.test");
  check("verified sign-in preserves an explicitly imported owner identity", owner.user.id === ownerId);
  const deviceKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const hostId = randomUUID();
  const ownerMembershipId = randomUUID();
  const registered = await request("POST", "/v2/remote/hosts/register", owner.sessionToken, {
    hostId,
    ownerMembershipId,
    name: "VPS Test Host",
    devicePublicKey: deviceKey,
  });
  check(
    "the existing host ID and public key can be registered on the independent service",
    registered.status === 201 && registered.body.hostId === hostId,
    registered.status,
  );
  const directoryReply = await request("GET", "/v2/remote/hosts/", owner.sessionToken);
  const hosts = Schema.decodeUnknownSync(
    Schema.Struct({
      hosts: Schema.Array(
        Schema.Struct({ hostId: Schema.String, memberLimit: Schema.Number, devicePublicKey: Schema.String }),
      ),
    }),
  )(directoryReply.body).hosts;
  check(
    "the real HTTP directory advertises ten seats and preserves the host key",
    hosts[0]?.memberLimit === 10 && hosts[0].devicePublicKey === deviceKey && hosts[0].hostId === hostId,
  );
  const invited = await request("POST", `/v2/remote/hosts/${hostId}/invites`, owner.sessionToken, {
    role: "member",
    permanent: true,
  });
  check("the owner can create a reusable invitation", invited.status === 201, invited.status);
  const link = Schema.decodeUnknownSync(Invitation)(invited.body);
  registerSecretValue(link.token);
  const members: string[] = [];
  for (let index = 1; index <= 9; index += 1) {
    const actor = await signIn(`member-${index}@vps.example.test`);
    const joined = await request("POST", "/v2/remote/invites/accept", actor.sessionToken, { token: link.token });
    check(`invited member ${index} joins within ten seats`, joined.status === 200, joined.status);
    members.push(Schema.decodeUnknownSync(Membership)(joined.body).membershipId);
  }
  const eleventh = await signIn("eleventh@vps.example.test");
  const refused = await request("POST", "/v2/remote/invites/accept", eleventh.sessionToken, { token: link.token });
  const code = isDynamicRecord(refused.body.error) ? refused.body.error.code : refused.body.code;
  check(
    "the eleventh person is refused at the real HTTP boundary",
    refused.status === 409 && code === "member_limit_reached",
    refused.status,
  );
  const memberId = members[0];
  assert.ok(memberId);
  const removed = await request("DELETE", `/v2/remote/hosts/${hostId}/members/${memberId}`, owner.sessionToken);
  check("removal returns the released 204 contract", removed.status === 204, removed.status);
  const replacement = await request("POST", "/v2/remote/invites/accept", eleventh.sessionToken, { token: link.token });
  check("a new acceptance fills the freed seat", replacement.status === 200, replacement.status);
  const full = await request("PATCH", `/v2/remote/hosts/${hostId}/members/${memberId}`, owner.sessionToken, {
    role: "member",
    reactivate: true,
  });
  check("reactivation cannot bypass ten seats", full.status === 409, full.status);

  const identityBefore = await readFile(join(directory, "identity.secret.json"));
  await server.close();
  resources.close();
  resources = await createVpsBindings(options);
  server = await startIsolatedServer();
  origin = `http://127.0.0.1:${server.port}`;
  const me = await request("GET", "/v1/me", owner.sessionToken);
  check(
    "the account session and imported identity survive restart",
    me.status === 200 && me.body.id === ownerId,
    me.status,
  );
  const restored = await request("GET", `/v2/remote/hosts/${hostId}/members/`, owner.sessionToken);
  const rows = Schema.decodeUnknownSync(
    Schema.Struct({ members: Schema.Array(Schema.Struct({ status: Schema.String })) }),
  )(restored.body).members;
  check("ten active memberships survive restart", rows.filter((member) => member.status === "active").length === 10);
  check(
    "restart keeps signing identity and applies no migration again",
    identityBefore.equals(await readFile(join(directory, "identity.secret.json"))) &&
      resources.appliedMigrations.length === 0,
  );
  const page = await fetch(`${origin}/app`);
  check(
    "the independent service serves the browser app",
    page.status === 200 && (page.headers.get("Content-Type") ?? "").includes("text/html"),
    page.status,
  );
  if (process.argv.includes("--browser")) {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.name));
      await page.goto(`${origin}/app`);
      await page.locator('input[type="email"]').waitFor({ timeout: 30_000 });
      const sendButton = page.getByRole("button", { name: /Send sign-in code|Enviar código de login/ });
      await page.locator('input[type="email"]').fill("browser@vps.example.test");
      await sendButton.click({ trial: true });
      await page.screenshot({ path: join(OUT, "login.png"), fullPage: true });
      check("the VPS browser sign-in screen hydrates without a script error", errors.length === 0);
      const started = page.waitForResponse((response) => response.url().endsWith("/api/browser/email/start"));
      await sendButton.click();
      const challenge = Schema.decodeUnknownSync(SignInStart)(await (await started).json());
      registerSecretValue(challenge.developmentCode, { allowShort: true });
      const verified = page.waitForResponse((response) => response.url().endsWith("/api/browser/email/verify"));
      await page.locator('input[autocomplete="one-time-code"]').fill(challenge.developmentCode);
      check("the real browser verifies its own email code through the VPS service", (await verified).status() === 200);
      check("browser authentication introduces no script error", errors.length === 0);
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.name : "Unknown";
} finally {
  await server.close();
  resources.close();
  await rm(temporary, { recursive: true, force: true });
}
const report = {
  passed: !failure && checks.length > 0 && checks.every((item) => item.passed),
  checks,
  failure,
  limits:
    "Local, isolated development codes only; no real email, upstream accounts or main profile changed. Production SMTP, Signal/TURN, TLS domain and actual account migration remain separate checks.",
};
await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
// Machine-readable: no credentials, invitation tokens, codes or response bodies.
process.stdout.write(
  `${report.passed ? "PASS" : "FAIL"} VPS account HTTP E2E (${checks.length} checks); ${join(OUT, "report.json")}\n`,
);
if (!report.passed) process.exitCode = 1;
