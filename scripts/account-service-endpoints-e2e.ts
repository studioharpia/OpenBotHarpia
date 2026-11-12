// Exercises the same userData file reader used before OpenBot creates its account services.
// Run: bun scripts/account-service-endpoints-e2e.ts
// It writes .openbot-build/account-service-endpoints-e2e/report.json.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAccountServiceEndpoints } from "../src/main/account-service-endpoints";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "account-service-endpoints-e2e");
const checks: { name: string; passed: boolean; detail?: string }[] = [];

function check(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

function expectInvalid(name: string, userDataPath: string): void {
  try {
    readAccountServiceEndpoints(userDataPath, {});
    check(name, false, "invalid operator endpoint configuration was accepted");
  } catch {
    check(name, true);
  }
}

async function run(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "openbot-account-endpoints-e2e-"));
  try {
    const absent = readAccountServiceEndpoints(temporary, {});
    check(
      "missing operator file preserves the packaged and development defaults",
      absent.authApiUrl === undefined && absent.signalUrl === undefined,
    );

    const distributionDefaults = {
      authApiUrl: "https://openbot.harpia.digital",
      signalUrl: "wss://openbot.harpia.digital/v1/signal",
    };
    const freshDistribution = readAccountServiceEndpoints(temporary, {}, distributionDefaults);
    check(
      "fresh HARPIA profile uses the distribution endpoints without writing operator state",
      freshDistribution.authApiUrl === distributionDefaults.authApiUrl &&
        freshDistribution.signalUrl === distributionDefaults.signalUrl,
    );

    const filePath = join(temporary, "account-service-endpoints.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "https://accounts.example.test",
        signalUrl: "wss://signal.example.test/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    const fromFile = readAccountServiceEndpoints(temporary, {});
    check(
      "operator file supplies HTTPS account and WSS Signal endpoints",
      fromFile.authApiUrl === "https://accounts.example.test" &&
        fromFile.signalUrl === "wss://signal.example.test/v1/signal",
    );

    const existingDistribution = readAccountServiceEndpoints(temporary, {}, distributionDefaults);
    check(
      "existing operator endpoints take priority over distribution defaults",
      existingDistribution.authApiUrl === fromFile.authApiUrl && existingDistribution.signalUrl === fromFile.signalUrl,
    );

    const envOverrides = readAccountServiceEndpoints(temporary, {
      OPENBOT_AUTH_API_URL: "https://env-accounts.example.test/",
    });
    check(
      "explicit environment API URL wins while the file still supplies Signal",
      envOverrides.authApiUrl === "https://env-accounts.example.test/" &&
        envOverrides.signalUrl === "wss://signal.example.test/v1/signal",
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "http://accounts.example.test",
        signalUrl: "wss://signal.example.test/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    const overrideInvalidApi = readAccountServiceEndpoints(temporary, {
      OPENBOT_AUTH_API_URL: "https://env-accounts.example.test",
    });
    check(
      "explicit environment API URL overrides its invalid file value independently",
      overrideInvalidApi.authApiUrl === "https://env-accounts.example.test" &&
        overrideInvalidApi.signalUrl === "wss://signal.example.test/v1/signal",
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "http://127.0.0.1:3100",
        signalUrl: "ws://localhost:8080/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    const loopback = readAccountServiceEndpoints(temporary, {});
    check(
      "HTTP and WS are accepted only for loopback endpoints",
      loopback.authApiUrl === "http://127.0.0.1:3100" && loopback.signalUrl === "ws://localhost:8080/v1/signal",
    );

    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "http://accounts.example.test",
        signalUrl: "wss://signal.example.test/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    expectInvalid("plain HTTP account endpoint is rejected outside loopback", temporary);
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "http://[::1]:3100",
        signalUrl: "wss://signal.example.test/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    expectInvalid("HTTP IPv6 account loopback follows the existing auth URL contract", temporary);
    await writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        authApiOrigin: "https://accounts.example.test",
        signalUrl: "ws://signal.example.test/v1/signal",
      })}\n`,
      { mode: 0o600 },
    );
    expectInvalid("plain WS Signal endpoint is rejected outside loopback", temporary);
  } catch (error) {
    check("endpoint configuration E2E completes", false, error instanceof Error ? error.message : String(error));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const failures = checks.filter((entry) => !entry.passed);
  await writeFile(
    join(OUT, "report.json"),
    `${JSON.stringify({ checks, finishedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `${failures.length ? "FAIL" : "PASS"} account service endpoints E2E (${checks.length} checks)\n`,
  );
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void run();
