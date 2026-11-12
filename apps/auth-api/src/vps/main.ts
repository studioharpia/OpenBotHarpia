import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDynamicRecord, isFunction } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger, registerSecretValues } from "@openbot/logging";
import { createVpsBindings } from "./bindings";
import { startVpsAccountServer, type VpsServerEntry } from "./http-server";

const logger = createOpenBotLogger("account-vps");

function isServerEntry(value: unknown): value is VpsServerEntry {
  return (
    isDynamicRecord(value) && isFunction(value.fetch) && (value.scheduled === undefined || isFunction(value.scheduled))
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("encrypted:"))
    throw new Error(`${name} must be configured before starting the account service.`);
  return value;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const publicOrigin = new URL(required("OPENBOT_AUTH_PUBLIC_ORIGIN"));
  const hostname = process.env.OPENBOT_API_HOST ?? "127.0.0.1";
  const port = Number(process.env.OPENBOT_API_PORT ?? "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid account service port.");
  const development = ["1", "true", "yes", "on"].includes(
    process.env.AUTH_EXPOSE_DEVELOPMENT_CODE?.trim().toLowerCase() ?? "",
  );
  if (
    development &&
    (process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(publicOrigin.hostname))
  )
    throw new Error("Development sign-in codes are restricted to an isolated loopback test server.");
  if (!development) {
    for (const name of [
      "EMAIL_SMTP_HOST",
      "EMAIL_SMTP_PORT",
      "EMAIL_SMTP_USERNAME",
      "EMAIL_SMTP_PASSWORD",
      "EMAIL_FROM",
    ])
      required(name);
    if (Number(process.env.EMAIL_SMTP_PORT) !== 465) throw new Error("SMTP requires implicit TLS on port 465.");
  }
  const signal = new URL(required("REMOTE_SIGNAL_URL"));
  if (signal.username || signal.password || signal.search || signal.hash || signal.pathname !== "/v1/signal")
    throw new Error("Invalid standalone Signal URL.");
  if (
    signal.protocol !== "wss:" &&
    !(signal.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(signal.hostname))
  )
    throw new Error("The standalone Signal URL must use WSS.");
  const webhook = new URL(signal);
  webhook.protocol = signal.protocol === "wss:" ? "https:" : "http:";
  webhook.pathname = "/internal/auth-events";
  const root = resolve(import.meta.dirname, "../..");
  const entryPath = process.env.OPENBOT_AUTH_SERVER_ENTRY ?? resolve(root, "dist-vps/server/server.js");
  const imported = await import(pathToFileURL(entryPath).href);
  if (!isDynamicRecord(imported) || !isServerEntry(imported.default))
    throw new Error("The built standalone account entry is invalid.");
  registerSecretValues(
    Object.entries(process.env)
      .filter(([key, value]) => /SECRET|TOKEN|PASSWORD|PRIVATE/u.test(key) && Boolean(value))
      .map(([, value]) => value ?? ""),
  );
  const resources = await createVpsBindings({
    directory: resolve(required("OPENBOT_AUTH_STATE_DIRECTORY")),
    migrations: resolve(root, "migrations"),
    signalUrl: signal.href,
    webhookUrl: webhook.href,
    environment: process.env,
  });
  try {
    const server = await startVpsAccountServer({
      entry: imported.default,
      bindings: resources.bindings,
      publicOrigin: publicOrigin.href,
      hostname,
      port,
      assetsDirectory: resolve(root, "dist-vps/client"),
      ...(process.env.OPENBOT_AUTH_TRUSTED_PROXY_IPS === undefined
        ? {}
        : {
            trustedProxyIPs: process.env.OPENBOT_AUTH_TRUSTED_PROXY_IPS.split(",")
              .map((ip) => ip.trim())
              .filter(Boolean),
          }),
    });
    logger.info("Standalone account service started.", {
      port: server.port,
      migrations: resources.appliedMigrations.length,
    });
    await new Promise<void>((done) => {
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
    await server.close();
  } finally {
    resources.close();
  }
}

void main().catch((error) => {
  logger.error("Standalone account service could not run.", {
    type: error instanceof Error ? error.name : "Unknown",
    configuration: error instanceof Error && error.message.includes("must be configured") ? error.message : undefined,
  });
  process.exitCode = 1;
});
