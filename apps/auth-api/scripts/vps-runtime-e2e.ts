// Exercises the real HTTP boundary and CLI startup guards without touching a deployed service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createVpsBindings } from "../src/vps/bindings";
import { startVpsAccountServer, type VpsServerEntry } from "../src/vps/http-server";
import { VpsRateLimiter } from "../src/vps/rate-limiter";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build/vps-runtime-e2e");
const temporary = await mkdtemp(join(tmpdir(), "openbot-vps-runtime-"));
const assets = join(temporary, "public");
const checks: { name: string; passed: boolean }[] = [];
function check(name: string, value: boolean) {
  checks.push({ name, passed: value });
  assert.ok(value, name);
}
async function refused(name: string, overrides: NodeJS.ProcessEnv) {
  const directory = join(temporary, `guard-${checks.length}`);
  const child = spawn(process.execPath, [join(ROOT, "apps/auth-api/src/vps/main.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENBOT_AUTH_PUBLIC_ORIGIN: "https://accounts.example.test",
      OPENBOT_AUTH_STATE_DIRECTORY: directory,
      REMOTE_SIGNAL_URL: "wss://signal.example.test/v1/signal",
      EMAIL_SMTP_HOST: "",
      EMAIL_SMTP_PORT: "",
      EMAIL_SMTP_USERNAME: "",
      EMAIL_SMTP_PASSWORD: "",
      EMAIL_FROM: "",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Keep diagnostics private: a guard failure is represented only by its exit status and untouched state.
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  const exists = await stat(directory).then(
    () => true,
    () => false,
  );
  check(name, code === 1 && !exists);
}
let failure: string | undefined;
try {
  for (const flag of ["true", "1", "YES", "on"]) {
    await refused(`production refuses development-code flag ${flag}`, {
      NODE_ENV: "production",
      AUTH_EXPOSE_DEVELOPMENT_CODE: flag,
    });
  }
  await refused("development codes cannot be exposed on a public listener", {
    NODE_ENV: "development",
    AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
    OPENBOT_API_HOST: "0.0.0.0",
    OPENBOT_AUTH_PUBLIC_ORIGIN: "http://127.0.0.1",
  });
  await refused("development codes cannot use a public origin", {
    NODE_ENV: "development",
    AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
    OPENBOT_API_HOST: "127.0.0.1",
  });
  await refused("production fails before creating state when SMTP is missing", {
    NODE_ENV: "production",
    AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
  });
  await refused("production refuses a non-TLS SMTP port before creating state", {
    NODE_ENV: "production",
    AUTH_EXPOSE_DEVELOPMENT_CODE: "false",
    EMAIL_SMTP_HOST: "mail.example.test",
    EMAIL_SMTP_PORT: "587",
    EMAIL_SMTP_USERNAME: "fixture",
    EMAIL_SMTP_PASSWORD: "fixture-not-a-secret",
    EMAIL_FROM: "fixture@example.test",
  });
  await mkdir(assets);
  await writeFile(join(assets, "asset.txt"), "public fixture");
  await writeFile(join(temporary, "private.txt"), "private fixture");
  await symlink(join(temporary, "private.txt"), join(assets, "escape.txt"));
  const resources = await createVpsBindings({
    directory: join(temporary, "state"),
    migrations: join(ROOT, "apps/auth-api/migrations"),
    signalUrl: "ws://127.0.0.1:9/v1/signal",
    webhookUrl: "http://127.0.0.1:9/internal/auth-events",
    environment: {},
  });
  const limiter = new VpsRateLimiter(2, 60);
  let streamedBody: ReadableStream<Uint8Array> | undefined;
  let cancelledStream: (() => void) | undefined;
  const cancelled = new Promise<void>((done) => {
    cancelledStream = done;
  });
  const entry: VpsServerEntry = {
    async fetch(request) {
      if (new URL(request.url).pathname === "/stream") {
        streamedBody = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelledStream?.();
          },
        });
        return new Response(streamedBody);
      }
      if (new URL(request.url).pathname === "/limited") {
        return new Response(null, {
          status: (await limiter.limit({ key: request.headers.get("CF-Connecting-IP") ?? "" })).success ? 204 : 429,
        });
      }
      return Response.json(
        {
          ip: request.headers.get("CF-Connecting-IP"),
          forwarded: request.headers.get("X-Forwarded-For"),
          origin: new URL(request.url).origin,
        },
        {
          headers: [
            ["Set-Cookie", "one=1; HttpOnly"],
            ["Set-Cookie", "two=2; HttpOnly"],
          ],
        },
      );
    },
  };
  const server = await startVpsAccountServer({
    entry,
    bindings: resources.bindings,
    publicOrigin: "https://accounts.example.test",
    hostname: "127.0.0.1",
    port: 0,
    assetsDirectory: assets,
    scheduled: false,
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const reply = await fetch(`${origin}/probe`, {
      headers: { "CF-Connecting-IP": "192.0.2.99", "X-Forwarded-For": "192.0.2.98", Host: "attacker.example.test" },
    });
    const body = await reply.json();
    assert.ok(isDynamicRecord(body));
    check(
      "untrusted clients cannot forge their IP or the public origin",
      body.ip === "127.0.0.1" && body.forwarded === null && body.origin === "https://accounts.example.test",
    );
    check("the HTTP boundary preserves separate session cookie headers", reply.headers.getSetCookie().length === 2);
    for (let index = 0; index < 3; index += 1) {
      const result = await fetch(`${origin}/limited`, {
        headers: { "CF-Connecting-IP": `192.0.2.${index}`, "X-Forwarded-For": `192.0.2.${index}` },
      });
      check(
        `rate limit uses the verified client address for request ${index + 1}`,
        result.status === (index < 2 ? 204 : 429),
      );
    }
    const asset = await fetch(`${origin}/asset.txt`);
    check(
      "public assets retain their content and MIME type",
      (await asset.text()) === "public fixture" && asset.headers.get("Content-Type") === "text/plain",
    );
    const symlinkReply = await fetch(`${origin}/escape.txt`);
    check(
      "a public symlink cannot reveal a file outside the asset directory",
      !(await symlinkReply.text()).includes("private fixture"),
    );
    const rawStatus = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port: server.port, path: "/\\attacker.example.test/probe" },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end();
    });
    check("an origin-changing backslash path is refused", rawStatus === 400);
    const oversized = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/probe",
          headers: { "Content-Length": 101 * 1024 * 1024 },
        },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      request.once("error", reject);
      request.end();
    });
    check("an oversized request is refused before buffering its body", oversized === 413);
    await new Promise<void>((done, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: server.port, path: "/stream" }, (response) => {
        response.once("data", () => {
          response.destroy();
          done();
        });
      });
      request.once("error", reject);
      request.end();
    });
    await Promise.race([
      cancelled,
      new Promise<never>((_done, reject) => {
        const signal = AbortSignal.timeout(5000);
        signal.addEventListener("abort", () => reject(new Error("Response cancellation timed out.")), { once: true });
      }),
    ]);
    check("a disconnected streaming client cancels its source under backpressure", true);
    await Promise.resolve();
    check("the disconnected response releases its reader lock", streamedBody !== undefined && !streamedBody.locked);
    check(
      "runtime identity is persisted with restricted permissions",
      ((await stat(join(temporary, "state/identity.secret.json"))).mode & 0o777) === 0o600,
    );
    check(
      "object storage and account databases remain separate",
      (await readFile(join(temporary, "state/accounts.sqlite"))).length > 0 &&
        (await stat(join(temporary, "state/objects.sqlite"))).size > 0,
    );
  } finally {
    await server.close();
    resources.close();
  }
  await chmod(join(temporary, "state"), 0o755);
  await chmod(join(temporary, "state/identity.secret.json"), 0o644);
  const restored = await createVpsBindings({
    directory: join(temporary, "state"),
    migrations: join(ROOT, "apps/auth-api/migrations"),
    signalUrl: "ws://127.0.0.1:9/v1/signal",
    webhookUrl: "http://127.0.0.1:9/internal/auth-events",
    environment: {},
  });
  try {
    check(
      "restored state and identity recover restricted permissions",
      ((await stat(join(temporary, "state"))).mode & 0o777) === 0o700 &&
        ((await stat(join(temporary, "state/identity.secret.json"))).mode & 0o777) === 0o600,
    );
  } finally {
    restored.close();
  }
} catch (error) {
  failure = error instanceof Error ? error.name : "Unknown";
} finally {
  await rm(temporary, { recursive: true, force: true });
}
await mkdir(OUT, { recursive: true });
const passed = !failure && checks.length > 0 && checks.every((check) => check.passed);
await writeFile(
  join(OUT, "report.json"),
  `${JSON.stringify({ passed, checks, failure, limits: "Isolated local HTTP boundary and CLI guards; public DNS, reverse proxy TLS and external SMTP are not exercised." }, null, 2)}\n`,
);
process.stdout.write(
  `${passed ? "PASS" : "FAIL"} VPS runtime E2E (${checks.length} checks); ${join(OUT, "report.json")}\n`,
);
if (!passed) process.exitCode = 1;
