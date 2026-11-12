import { generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerSecretValues } from "@openbot/logging";
import { Schema } from "effect";
import { readLocalRuntimeVars } from "../server/runtime-env";
import type { WorkerBindings } from "../server/types";
import { VpsObjectStore } from "./object-store";
import { VpsRateLimiter } from "./rate-limiter";
import { vpsSmtpConnector } from "./smtp-connector";
import { applyVpsMigrations, openVpsSqliteDatabase } from "./sqlite-database";

const Identity = Schema.Struct({
  version: Schema.Literal(1),
  keyId: Schema.String,
  privateJwk: Schema.String,
  publicJwks: Schema.String,
  webhookSecret: Schema.String,
});

/** The standalone service owns its signing identity; restarting never silently replaces it. */
async function identity(directory: string): Promise<typeof Identity.Type> {
  const path = join(directory, "identity.secret.json");
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Account signing identity must be a regular file.");
    await chmod(path, 0o600);
    return Schema.decodeUnknownSync(Identity)(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const existing = await stat(join(directory, "accounts.sqlite")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && existing.size > 0)
    throw new Error("Restore the account signing identity before opening its database.");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyId = crypto.randomUUID();
  const data: typeof Identity.Type = {
    version: 1,
    keyId,
    privateJwk: JSON.stringify({ ...pair.privateKey.export({ format: "jwk" }), kid: keyId, alg: "ES256", use: "sig" }),
    publicJwks: JSON.stringify({
      keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: keyId, alg: "ES256", use: "sig" }],
    }),
    webhookSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url"),
  };
  await writeFile(path, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
  return data;
}

export async function createVpsBindings(options: {
  directory: string;
  migrations: string;
  signalUrl: string;
  webhookUrl: string;
  environment: NodeJS.ProcessEnv;
}): Promise<{ bindings: WorkerBindings; close(): void; appliedMigrations: string[] }> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const keys = await identity(options.directory);
  registerSecretValues([keys.privateJwk, keys.webhookSecret]);
  const database = await openVpsSqliteDatabase(join(options.directory, "accounts.sqlite"));
  const buckets: VpsObjectStore[] = [];
  try {
    const appliedMigrations = await applyVpsMigrations(database, options.migrations);
    const bucket = (name: string) => {
      const object = new VpsObjectStore(join(options.directory, "objects.sqlite"), name);
      buckets.push(object);
      return object;
    };
    const bindings: WorkerBindings = {
      ...readLocalRuntimeVars(options.environment),
      DB: database,
      AVATARS: bucket("avatars"),
      SKILLS: bucket("skills"),
      SITES: bucket("sites"),
      MARKETPLACE_INGRESS_RATE_LIMITER: new VpsRateLimiter(300, 60),
      MARKETPLACE_MUTATION_RATE_LIMITER: new VpsRateLimiter(30, 60),
      MARKETPLACE_UPLOAD_RATE_LIMITER: new VpsRateLimiter(5, 60),
      SITE_REPORT_RATE_LIMITER: new VpsRateLimiter(10, 60),
      GITHUB_TOKEN_RATE_LIMITER: new VpsRateLimiter(30, 60),
      LIVE_ACTIVITY_RATE_LIMITER: new VpsRateLimiter(300, 60),
      FEEDBACK_RATE_LIMITER: new VpsRateLimiter(3, 60),
      EMAIL_SMTP_CONNECTOR: vpsSmtpConnector,
      REMOTE_TICKET_KEY_ID: keys.keyId,
      REMOTE_TICKET_PRIVATE_JWK: keys.privateJwk,
      REMOTE_TICKET_PUBLIC_JWKS: keys.publicJwks,
      REMOTE_AUTH_WEBHOOK_SECRET: keys.webhookSecret,
      REMOTE_SIGNAL_URL: options.signalUrl,
      REMOTE_AUTH_WEBHOOK_URL: options.webhookUrl,
      HOSTED_SERVERS_ENABLED: "false",
    };
    return {
      bindings,
      appliedMigrations,
      close() {
        for (const bucket of buckets) bucket.close();
        database.close();
      },
    };
  } catch (error) {
    for (const bucket of buckets) bucket.close();
    database.close();
    throw error;
  }
}
