// Runs the source route handlers over loopback HTTP, persistent SQLite and SMTP/TLS.
// No production build, real mailbox, account or installed application is used.
// Run: bun --conditions=browser apps/auth-api/scripts/vps-invite-email-e2e.ts
// Optional browser check: INVITE_E2E_VITE_ORIGIN=http://127.0.0.1:<dev-port> <command>
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import {
  createInviteUrl,
  createOpenBotInviteUrl,
  createWebAppInvitePath,
  inviteUrlFromWebAppSearch,
  parseInviteUrl,
} from "@openbot/contracts/invite-links";
import { redactText, registerSecretValue } from "@openbot/logging";
import { RemoteTeamDirectoryClient } from "@openbot/team-client/remote-directory";
import { Effect, Result, Schema, Semaphore } from "effect";
import { Route as browserRoute } from "../src/routes/api/browser/$";
import { Route as startRoute } from "../src/routes/v1/auth/email/start";
import { Route as verifyRoute } from "../src/routes/v1/auth/email/verify";
import { Route as emailRoute } from "../src/routes/v1/team-invitations/email";
import { Route as invitesRoute } from "../src/routes/v2/remote/hosts/$hostId/invites";
import { Route as hostsRoute } from "../src/routes/v2/remote/hosts/index";
import { Route as registerRoute } from "../src/routes/v2/remote/hosts/register";
import { Route as revokeRoute } from "../src/routes/v2/remote/invites/$inviteId";
import { Route as acceptRoute } from "../src/routes/v2/remote/invites/accept";
import { Route as previewRoute } from "../src/routes/v2/remote/invites/preview";
import { withAccountRequest } from "../src/server/request-context";
import { createVpsBindings } from "../src/vps/bindings";
import { startVpsAccountServer } from "../src/vps/http-server";
import { vpsSmtpConnector } from "../src/vps/smtp-connector";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build/vps-invite-email-e2e");
const ORIGIN = "https://invites.openbot.test";
const LINK_OPTIONS = { selfHostedApiOrigin: ORIGIN };
const SignInStart = Schema.Struct({ challengeId: Schema.String, developmentCode: Schema.String });
const SignedIn = Schema.Struct({ sessionToken: Schema.String });
type InviteFixturePayload =
  | { email: string }
  | { challengeId: string; code: string }
  | { hostId: string; ownerMembershipId: string; name: string; devicePublicKey: string }
  | { email: string; role: string; inviteUrl: string };
const checks: { name: string; passed: boolean; status?: number }[] = [];
function check(name: string, passed: boolean, status?: number) {
  checks.push({ name, passed, ...(status === undefined ? {} : { status }) });
  assert.ok(passed, name);
}

// Adapt the framework's registered runtime handlers at this harness boundary. The harness
// supplies only the request and path params that these real API handlers consume.
interface SourceRouteInput {
  request: Request;
  params: Record<string, string>;
}
type SourceRouteHandler = (input: SourceRouteInput) => Response | Promise<Response>;
const SourceRoute = Schema.Struct({
  server: Schema.Struct({
    handlers: Schema.Record(
      Schema.String,
      Schema.declare<SourceRouteHandler>((value): value is SourceRouteHandler => typeof value === "function"),
    ),
  }),
});
async function invokeRoute(route: { options: object }, request: Request, params: Record<string, string> = {}) {
  const handlers = Schema.decodeUnknownSync(SourceRoute)(route.options).server.handlers;
  const handler = handlers[request.method] ?? handlers.ANY;
  assert.ok(handler);
  const response = await handler({ request, params });
  assert.ok(response instanceof Response);
  return response;
}

async function run(temporary: string) {
  const messages: { recipient: string; content: string }[] = [];
  const sockets = new Set<TLSSocket>();
  let rejectMail = false;
  const smtp = createServer(
    { key: await readFile(join(temporary, "key.pem")), cert: await readFile(join(temporary, "cert.pem")) },
    (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      socket.write("220 localhost ESMTP fixture\r\n");
      let pending = "";
      let recipient = "";
      let message = "";
      let data = false;
      socket.on("data", (chunk) => {
        pending += chunk;
        for (;;) {
          const end = pending.indexOf("\r\n");
          if (end < 0) break;
          const line = pending.slice(0, end);
          pending = pending.slice(end + 2);
          if (data) {
            if (line === ".") {
              messages.push({ recipient, content: message });
              data = false;
              socket.write("250 message accepted\r\n");
            } else message += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          } else if (line.startsWith("EHLO ")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
          else if (line.startsWith("AUTH PLAIN ")) socket.write("235 authenticated\r\n");
          else if (line.startsWith("MAIL FROM:")) socket.write("250 sender accepted\r\n");
          else if (line.startsWith("RCPT TO:")) {
            recipient = line.slice("RCPT TO:<".length, -1);
            socket.write(rejectMail ? "550 recipient rejected by fixture\r\n" : "250 recipient accepted\r\n");
          } else if (line === "DATA") {
            data = true;
            message = "";
            socket.write("354 send message\r\n");
          } else if (line === "QUIT") socket.write("221 closing\r\n");
          else socket.write("500 unsupported command\r\n");
        }
      });
    },
  );
  await new Promise<void>((done) => smtp.listen(0, "localhost", done));
  const smtpAddress = smtp.address();
  assert.ok(smtpAddress && typeof smtpAddress === "object");
  const resources = await createVpsBindings({
    directory: join(temporary, "state"),
    migrations: join(ROOT, "apps/auth-api/migrations"),
    signalUrl: "ws://127.0.0.1:9/v1/signal",
    webhookUrl: "http://127.0.0.1:9/internal/auth-events",
    environment: {
      AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
      EMAIL_SMTP_HOST: "localhost",
      EMAIL_SMTP_PORT: "465",
      EMAIL_SMTP_USERNAME: "sender@example.test",
      EMAIL_SMTP_PASSWORD: "local-fixture-only",
      EMAIL_FROM: "sender@example.test",
    },
  });
  resources.bindings.EMAIL_SMTP_CONNECTOR = (target, options) => {
    assert.equal(target.hostname, "localhost");
    assert.equal(target.port, 465);
    return vpsSmtpConnector({ hostname: "localhost", port: smtpAddress.port }, options);
  };
  const entry = {
    fetch(request: Request, bindings: typeof resources.bindings, context: { waitUntil(work: Promise<unknown>): void }) {
      return withAccountRequest(bindings, context.waitUntil, () => {
        const url = new URL(request.url);
        const hostMatch = /^\/v2\/remote\/hosts\/([^/]+)\/invites\/?$/u.exec(url.pathname);
        const revokeMatch = /^\/v2\/remote\/invites\/([^/]+)$/u.exec(url.pathname);
        if (url.pathname.startsWith("/api/browser/")) return invokeRoute(browserRoute, request);
        if (url.pathname === "/v1/auth/email/start") return invokeRoute(startRoute, request);
        if (url.pathname === "/v1/auth/email/verify") return invokeRoute(verifyRoute, request);
        if (url.pathname === "/v1/team-invitations/email") return invokeRoute(emailRoute, request);
        if (url.pathname === "/v2/remote/hosts/register") return invokeRoute(registerRoute, request);
        if (url.pathname === "/v2/remote/hosts/") return invokeRoute(hostsRoute, request);
        if (url.pathname === "/v2/remote/invites/preview") return invokeRoute(previewRoute, request);
        if (url.pathname === "/v2/remote/invites/accept") return invokeRoute(acceptRoute, request);
        if (hostMatch?.[1]) {
          const params = { hostId: hostMatch[1] };
          return request.method === "POST"
            ? invokeRoute(invitesRoute, request, params)
            : invokeRoute(invitesRoute, request, params);
        }
        if (revokeMatch?.[1] && request.method === "DELETE")
          return invokeRoute(revokeRoute, request, { inviteId: revokeMatch[1] });
        return new Response(null, { status: 404 });
      });
    },
  };
  const server = await startVpsAccountServer({
    entry,
    bindings: resources.bindings,
    publicOrigin: ORIGIN,
    hostname: "127.0.0.1",
    port: 0,
    assetsDirectory: temporary,
    scheduled: false,
  });
  const localOrigin = `http://127.0.0.1:${server.port}`;
  const localFetch: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), ORIGIN);
      assert.equal(url.origin, ORIGIN, "The client must stay on its configured account service.");
      return fetch(`${localOrigin}${url.pathname}${url.search}`, init);
    },
    { preconnect: fetch.preconnect },
  );
  async function request(path: string, token?: string, body?: InviteFixturePayload, method = "POST") {
    const response = await localFetch(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: response.status === 204 ? {} : await response.json() };
  }
  async function signIn(email: string) {
    const started = await request("/v1/auth/email/start", undefined, { email });
    assert.equal(started.status, 200);
    const challenge = Schema.decodeUnknownSync(SignInStart)(started.body);
    registerSecretValue(challenge.developmentCode, { allowShort: true });
    const verified = await request("/v1/auth/email/verify", undefined, {
      challengeId: challenge.challengeId,
      code: challenge.developmentCode,
    });
    assert.equal(verified.status, 200);
    const actor = Schema.decodeUnknownSync(SignedIn)(verified.body);
    registerSecretValue(actor.sessionToken);
    return actor.sessionToken;
  }
  function directory(token: string) {
    return new RemoteTeamDirectoryClient({
      apiUrl: ORIGIN,
      token,
      fetch: localFetch,
      verifyHostKeySignature: () => Effect.succeed(false),
    });
  }
  const runEffect = <A, E>(value: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(value));
  let failure: string | undefined;
  try {
    const owner = await signIn("owner@example.test");
    const recipient = await signIn("recipient@example.test");
    const stranger = await signIn("stranger@example.test");
    check("three fixture accounts sign in through real HTTP routes", true);
    const devicePublicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const host = { hostId: randomUUID(), devicePublicKey, name: "Convite de teste local" };
    const registered = await request("/v2/remote/hosts/register", owner, {
      ...host,
      ownerMembershipId: randomUUID(),
    });
    check("owner registers a host in persistent SQLite", registered.status === 201, registered.status);
    const client = directory(owner);
    const emailed = await Effect.runPromise(
      client.sendInviteEmail(host, { role: "member", email: "recipient@example.test" }),
    );
    registerSecretValue(parseInviteUrl(emailed.inviteUrl, LINK_OPTIONS).token);
    check(
      "shared client creates and emails a self-hosted HTTPS invitation",
      new URL(emailed.inviteUrl).origin === ORIGIN,
    );
    const mail = messages.at(-1);
    const decodedMail = mail?.content
      .replace(/=\r\n/gu, "")
      .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    check(
      "SMTP/TLS accepts exactly one message for the requested recipient",
      messages.length === 1 && mail?.recipient === "recipient@example.test",
    );
    check(
      "email carries the configured HTTPS link in plain text and HTML",
      Boolean(
        decodedMail?.includes(emailed.inviteUrl) && decodedMail?.includes(emailed.inviteUrl.replaceAll("&", "&amp;")),
      ),
    );
    const browserPath = createWebAppInvitePath(emailed.inviteUrl, LINK_OPTIONS);
    check(
      "browser handoff preserves the invitation on its own origin",
      inviteUrlFromWebAppSearch(new URL(browserPath, ORIGIN).search, LINK_OPTIONS) === emailed.inviteUrl,
    );
    const legacy = createOpenBotInviteUrl(parseInviteUrl(emailed.inviteUrl, LINK_OPTIONS), LINK_OPTIONS);
    check("legacy openbot scheme remains readable", parseInviteUrl(legacy, LINK_OPTIONS).serverId === host.hostId);
    const stockPayload = { ...parseInviteUrl(emailed.inviteUrl, LINK_OPTIONS), apiUrl: "https://api.openbot.run/" };
    check(
      "public-service links keep their released origin",
      new URL(createInviteUrl(stockPayload)).origin === "https://openbot.run",
    );
    const memberClient = directory(recipient);
    const wrong = await runEffect(directory(stranger).acceptInvite(emailed.inviteUrl));
    check("another email cannot accept a recipient-bound invitation", Result.isFailure(wrong));
    const preview = await Effect.runPromise(memberClient.previewInvite(emailed.inviteUrl));
    check("recipient previews the real host and role", preview.hostId === host.hostId && preview.role === "member");
    const accepted = await Effect.runPromise(memberClient.acceptInvite(emailed.inviteUrl));
    check(
      "recipient accepts and obtains the expected membership",
      accepted.hostId === host.hostId && accepted.role === "member",
    );
    check(
      "accepted host appears in recipient directory",
      (await Effect.runPromise(memberClient.listHosts())).some((item) => item.hostId === host.hostId),
    );

    const open = await Effect.runPromise(client.createInvite(host, { role: "admin", email: "stranger@example.test" }));
    const emailInput = { email: "stranger@example.test", role: "admin", inviteUrl: open.inviteUrl };
    const beforeRefusals = messages.length;
    const cases = [
      { name: "unauthenticated sender", token: undefined, body: emailInput, status: 401 },
      { name: "member without invitation permission", token: recipient, body: emailInput, status: 400 },
      {
        name: "different recipient",
        token: owner,
        body: { ...emailInput, email: "recipient@example.test" },
        status: 400,
      },
      { name: "different role", token: owner, body: { ...emailInput, role: "member" }, status: 400 },
      {
        name: "public landing domain with a self-hosted token",
        token: owner,
        body: { ...emailInput, inviteUrl: open.inviteUrl.replace(ORIGIN, "https://openbot.run") },
        status: 400,
      },
      {
        name: "foreign landing domain",
        token: owner,
        body: { ...emailInput, inviteUrl: open.inviteUrl.replace(ORIGIN, "https://foreign.example.test") },
        status: 400,
      },
      {
        name: "foreign API origin",
        token: owner,
        body: {
          ...emailInput,
          inviteUrl: open.inviteUrl.replace(
            encodeURIComponent(`${ORIGIN}/`),
            encodeURIComponent("https://foreign.example.test/"),
          ),
        },
        status: 400,
      },
      {
        name: "landing/API mismatch",
        token: owner,
        body: {
          ...emailInput,
          inviteUrl: open.inviteUrl.replace(
            encodeURIComponent(`${ORIGIN}/`),
            encodeURIComponent("https://api.openbot.run/"),
          ),
        },
        status: 400,
      },
    ];
    for (const item of cases) {
      const reply = await request("/v1/team-invitations/email", item.token, item.body);
      check(`${item.name} is refused before SMTP`, reply.status === item.status, reply.status);
    }
    check("refused email requests deliver no messages", messages.length === beforeRefusals);
    await Effect.runPromise(client.revokeInvite(open.inviteId));
    const revokedMail = await request("/v1/team-invitations/email", owner, emailInput);
    check("revoked invitation cannot be emailed", revokedMail.status === 400, revokedMail.status);
    check(
      "revoked invitation cannot be accepted",
      Result.isFailure(await runEffect(directory(stranger).acceptInvite(open.inviteUrl))),
    );

    const expiring = await Effect.runPromise(
      client.createInvite(host, { role: "member", email: "stranger@example.test" }),
    );
    await resources.bindings.DB.prepare("UPDATE remote_invites SET expires_at = 1 WHERE invite_id = ?")
      .bind(expiring.inviteId)
      .run();
    const expired = await request("/v1/team-invitations/email", owner, {
      email: "stranger@example.test",
      role: "member",
      inviteUrl: expiring.inviteUrl,
    });
    check("expired invitation cannot be emailed", expired.status === 400, expired.status);
    check(
      "permanent invitation with email remains refused",
      Result.isFailure(
        await runEffect(client.createInvite(host, { role: "member", email: "stranger@example.test", permanent: true })),
      ),
    );

    rejectMail = true;
    const failedSend = await runEffect(client.sendInviteEmail(host, { role: "member", email: "failure@example.test" }));
    check("SMTP refusal reaches the client as a failure", Result.isFailure(failedSend));
    const outstanding = await Effect.runPromise(client.listInvites(host.hostId));
    check(
      "failed delivery revokes its undisclosed invitation",
      outstanding.some((item) => item.email === "failure@example.test" && item.revokedAt !== null),
    );
    check("failed and invalid sends deliver no further messages", messages.length === beforeRefusals);
    rejectMail = false;

    const adminInvite = await Effect.runPromise(
      client.createInvite(host, { role: "admin", email: "stranger@example.test" }),
    );
    const adminClient = directory(stranger);
    await Effect.runPromise(adminClient.acceptInvite(adminInvite.inviteUrl));
    const adminSent = await runEffect(
      adminClient.sendInviteEmail(host, { role: "member", email: "admin-recipient@example.test" }),
    );
    check("an authorized admin can send an invitation", Result.isSuccess(adminSent));
    const permanent = await Effect.runPromise(client.createInvite(host, { role: "member", permanent: true }));
    const permanentSend = await request("/v1/team-invitations/email", owner, {
      email: "stranger@example.test",
      role: "member",
      inviteUrl: permanent.inviteUrl,
    });
    check("server refuses emailing a permanent invitation", permanentSend.status === 400, permanentSend.status);
    const rateInvite = await Effect.runPromise(
      client.createInvite(host, { role: "member", email: "rate@example.test" }),
    );
    for (let index = 0; index < 5; index += 1) {
      const reply = await request("/v1/team-invitations/email", owner, {
        email: "rate@example.test",
        role: "member",
        inviteUrl: rateInvite.inviteUrl,
      });
      assert.equal(reply.status, 204);
    }
    const beforeRateRefusal = messages.length;
    const rateRefused = await request("/v1/team-invitations/email", owner, {
      email: "rate@example.test",
      role: "member",
      inviteUrl: rateInvite.inviteUrl,
    });
    check(
      "recipient rate limit remains enforced before SMTP",
      rateRefused.status === 429 && messages.length === beforeRateRefusal,
      rateRefused.status,
    );

    if (process.env.INVITE_E2E_VITE_ORIGIN) {
      const browserEmail = "browser@example.test";
      const browserInvite = await Effect.runPromise(
        client.sendInviteEmail(host, { role: "admin", email: browserEmail }),
      );
      registerSecretValue(parseInviteUrl(browserInvite.inviteUrl, LINK_OPTIONS).token);
      const browserLegacy = createOpenBotInviteUrl(parseInviteUrl(browserInvite.inviteUrl, LINK_OPTIONS), LINK_OPTIONS);
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ channel: "chrome", headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
        const errors: string[] = [];
        const proxySlots = Semaphore.makeUnsafe(4);
        await context.route("**/*", (route) =>
          Effect.runPromise(
            proxySlots
              .withPermit(
                Effect.tryPromise({
                  try: async () => {
                    const url = new URL(route.request().url());
                    if (url.origin !== ORIGIN) return route.abort();
                    const api = url.pathname.startsWith("/api/browser/");
                    const target = api ? localOrigin : process.env.INVITE_E2E_VITE_ORIGIN;
                    const response = await route.fetch({
                      url: `${target}${url.pathname}${url.search}`,
                      headers: { ...route.request().headers(), host: "127.0.0.1" },
                    });
                    await route.fulfill({ response });
                  },
                  catch: () => new Error("Local browser proxy failed."),
                }),
              )
              .pipe(
                Effect.catch(() =>
                  Effect.promise(async () => {
                    errors.push("LocalProxyFailure");
                    await route.abort().catch(() => undefined);
                  }),
                ),
              ),
          ),
        );
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.name));
        // The message and screenshots contain fixtures only; no real account is contacted.
        await page.goto(browserInvite.inviteUrl);
        const appLink = page.locator('a[href^="openbot://join"]');
        await appLink.waitFor();
        check(
          "real JoinPage opens the same self-hosted invitation in the app",
          (await appLink.getAttribute("href")) === browserLegacy,
        );
        await page.screenshot({ path: join(OUT, "convite-dominio-proprio.png"), fullPage: true });
        const webLink = page.locator('a[href^="/app?"]');
        await webLink.click();
        await page.locator('input[type="email"]').waitFor();
        check("real browser entry removes invitation credentials from the URL", new URL(page.url()).search === "");
        await page.screenshot({ path: join(OUT, "convite-login-navegador.png"), fullPage: true });
        const startedResponse = page.waitForResponse((response) => response.url().endsWith("/api/browser/email/start"));
        await page.locator('input[type="email"]').fill(browserEmail);
        await page.getByRole("button", { name: /Send sign-in code|Enviar código de login/ }).click();
        const challenge = Schema.decodeUnknownSync(SignInStart)(await (await startedResponse).json());
        registerSecretValue(challenge.developmentCode, { allowShort: true });
        const verifiedResponse = page.waitForResponse((response) =>
          response.url().endsWith("/api/browser/email/verify"),
        );
        await page.locator('input[autocomplete="one-time-code"]').fill(challenge.developmentCode);
        check("browser signs in through the real cookie API", (await verifiedResponse).status() === 200);
        const connect = page.getByRole("button", { name: /^(Connect|Conectar)$/ });
        await connect.waitFor();
        await page.screenshot({ path: join(OUT, "convite-verificado.png"), fullPage: true });
        check(
          "browser restores the invitation after legitimate sign-in",
          await page
            .getByRole("region", { name: /Verified invitation|Convite verificado/ })
            .getByRole("heading", { name: host.name, exact: true })
            .isVisible(),
        );
        const acceptedResponse = page.waitForResponse((response) =>
          response.url().endsWith("/api/browser/v2/remote/invites/accept"),
        );
        await connect.click();
        check("browser accepts through the real cookie API", (await acceptedResponse).status() === 200);
        const browserHosts = await page.evaluate(async () => {
          const response = await fetch("/api/browser/v2/remote/hosts/");
          return { status: response.status, body: await response.json() };
        });
        const memberships = Schema.decodeUnknownSync(
          Schema.Struct({ hosts: Schema.Array(Schema.Struct({ hostId: Schema.String })) }),
        )(browserHosts.body);
        check(
          "browser acceptance persists the membership",
          browserHosts.status === 200 && memberships.hosts.some((item) => item.hostId === host.hostId),
        );
        const cookieInvite = await Effect.runPromise(
          client.createInvite(host, { role: "member", email: "cookie@example.test" }),
        );
        const cookieReply = await page.evaluate(
          async (input) => {
            const response = await fetch("/api/browser/v1/team-invitations/email", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-OpenBot-Browser": "1" },
              body: JSON.stringify(input),
            });
            return response.status;
          },
          { email: "cookie@example.test", role: "member", inviteUrl: cookieInvite.inviteUrl },
        );
        check(
          "browser cookie route sends through real SMTP/TLS",
          cookieReply === 204 && messages.at(-1)?.recipient === "cookie@example.test",
          cookieReply,
        );
        check("join, sign-in and invitation introduce no script error", errors.length === 0);
      } catch (error) {
        const failedPage = browser.contexts()[0]?.pages()[0];
        await failedPage?.screenshot({ path: join(OUT, "browser-failure.png"), fullPage: true });
        console.error("Browser fixture failure:", error instanceof Error ? redactText(error.message) : "Unknown");
        throw error;
      } finally {
        await browser.close();
      }
    }
  } catch {
    failure =
      "A fixture assertion or operation failed; inspect the last recorded check. Payloads are intentionally omitted.";
    process.exitCode = 1;
  } finally {
    await server.close();
    resources.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => smtp.close(() => done()));
    const report = {
      passed: !failure && checks.every((item) => item.passed),
      runtime: "source HTTP routes + SQLite + SMTP/TLS, loopback only",
      origin: ORIGIN,
      browser: Boolean(process.env.INVITE_E2E_VITE_ORIGIN),
      checks,
      ...(failure ? { failure } : {}),
    };
    await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const item of checks)
      console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}${item.status ? ` (${item.status})` : ""}`);
    if (failure) console.error(failure);
  }
}

await mkdir(OUT, { recursive: true });
if (process.argv.includes("--fixture-child")) {
  const temporary = process.env.INVITE_E2E_TEMP;
  assert.ok(temporary);
  await run(temporary);
} else {
  const temporary = await mkdtemp(join(tmpdir(), "openbot-invite-email-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(temporary, "key.pem"),
        "-out",
        join(temporary, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    const child = spawn(process.execPath, ["--conditions=browser", import.meta.filename, "--fixture-child"], {
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        NODE_EXTRA_CA_CERTS: join(temporary, "cert.pem"),
        INVITE_E2E_TEMP: temporary,
        ...(process.env.INVITE_E2E_VITE_ORIGIN ? { INVITE_E2E_VITE_ORIGIN: process.env.INVITE_E2E_VITE_ORIGIN } : {}),
      },
    });
    process.exitCode = await new Promise<number>((done) => child.once("exit", (code) => done(code ?? 1)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
