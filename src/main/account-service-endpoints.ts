import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

const ENDPOINTS_FILE = "account-service-endpoints.json";
const StoredEndpoints = Schema.Struct({
  version: Schema.Literal(1),
  authApiOrigin: Schema.String,
  signalUrl: Schema.String,
});

export interface AccountServiceEndpoints {
  authApiUrl: string | undefined;
  signalUrl: string | undefined;
}

/** Reads the operator-owned endpoint file and applies explicit environment overrides independently. */
export function readAccountServiceEndpoints(
  userDataPath: string,
  environment: NodeJS.ProcessEnv,
  defaults?: AccountServiceEndpoints,
): AccountServiceEndpoints {
  const needsStoredApi = environment.OPENBOT_AUTH_API_URL === undefined;
  const needsStoredSignal = environment.OPENBOT_REMOTE_SIGNAL_URL === undefined;
  const stored = needsStoredApi || needsStoredSignal ? readStoredEndpoints(join(userDataPath, ENDPOINTS_FILE)) : null;
  return {
    authApiUrl:
      environment.OPENBOT_AUTH_API_URL ?? (stored ? requireApiOrigin(stored.authApiOrigin) : defaults?.authApiUrl),
    signalUrl:
      environment.OPENBOT_REMOTE_SIGNAL_URL ?? (stored ? requireSignalUrl(stored.signalUrl) : defaults?.signalUrl),
  };
}

function readStoredEndpoints(path: string): typeof StoredEndpoints.Type | null {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const value = Schema.decodeUnknownSync(StoredEndpoints)(JSON.parse(serialized));

  return {
    version: 1,
    authApiOrigin: value.authApiOrigin,
    signalUrl: value.signalUrl,
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isCentralAuthLoopback(hostname: string): boolean {
  // Keep this aligned with readCentralAuthApiUrl in central-auth-manager.ts.
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function requireApiOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && isCentralAuthLoopback(url.hostname)))
  ) {
    throw new Error(`${ENDPOINTS_FILE} authApiOrigin must be an HTTPS origin or an HTTP loopback origin.`);
  }
  return url.origin;
}

function requireSignalUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/v1/signal" ||
    url.search ||
    url.hash ||
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname)))
  ) {
    throw new Error(`${ENDPOINTS_FILE} signalUrl must use WSS or WS on loopback at /v1/signal.`);
  }
  return url.href;
}
