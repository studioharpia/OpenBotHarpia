import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import type { WorkerBindings } from "../server/types";

export interface VpsServerEntry {
  fetch(
    request: Request,
    bindings: WorkerBindings,
    context: { waitUntil(work: Promise<unknown>): void },
  ): Response | Promise<Response>;
  scheduled?(controller: { scheduledTime: number; cron: string }, bindings: WorkerBindings): Promise<void>;
}

const logger = createOpenBotLogger("account-vps");
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".vtt": "text/vtt",
};

/** The reverse proxy must be explicitly trusted before any forwarded client address is used. */
function requestHeaders(message: IncomingMessage, trustedProxies: ReadonlySet<string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  let address = message.socket.remoteAddress ?? "127.0.0.1";
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (trustedProxies.has(address)) {
    const forwarded = headers.get("X-Forwarded-For")?.split(",").at(-1)?.trim();
    if (forwarded && isIP(forwarded)) address = forwarded;
  }
  // This verified value is consumed by the existing account service IP policy. A caller cannot supply it.
  headers.set("CF-Connecting-IP", address);
  headers.delete("X-Forwarded-For");
  headers.delete("X-Real-IP");
  headers.delete("Forwarded");
  return headers;
}

function waitForWritable(target: ServerResponse): Promise<void> {
  return new Promise((done, reject) => {
    const cleanup = () => {
      target.off("drain", onDrain);
      target.off("close", onDrain);
      target.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      done();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    target.once("drain", onDrain);
    target.once("close", onDrain);
    target.once("error", onError);
    if (target.destroyed || target.writableEnded) onDrain();
  });
}

async function send(response: Response, target: ServerResponse, head: boolean): Promise<void> {
  const cookies = response.headers.getSetCookie();
  for (const [key, value] of response.headers) if (key.toLowerCase() !== "set-cookie") target.setHeader(key, value);
  if (cookies.length) target.setHeader("Set-Cookie", cookies);
  target.writeHead(response.status);
  if (head || !response.body) {
    await response.body?.cancel();
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const close = () => {
    if (!target.writableEnded) void reader.cancel().catch(() => undefined);
  };
  target.once("close", close);
  try {
    while (!target.destroyed) {
      const next = await reader.read();
      if (next.done) break;
      if (!target.write(next.value)) await waitForWritable(target);
    }
    target.end();
  } finally {
    target.off("close", close);
    reader.releaseLock();
  }
}

async function asset(request: Request, directory: string): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.includes("\0")) return null;
  const base = resolve(directory);
  const candidate = resolve(base, `.${path}`);
  if (!candidate.startsWith(`${base}${sep}`)) return null;
  try {
    const actual = await realpath(candidate);
    if (!actual.startsWith(`${base}${sep}`)) return null;
    const info = await stat(actual);
    if (!info.isFile()) return null;
    const data = request.method === "HEAD" ? null : new Uint8Array(await readFile(actual));
    return new Response(data, {
      headers: {
        "Content-Type": CONTENT_TYPES[extname(actual)] ?? "application/octet-stream",
        "Content-Length": String(info.size),
        "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

/** A native HTTP boundary around the same built route handlers, with invocation-owned work and shutdown. */
export async function startVpsAccountServer(options: {
  entry: VpsServerEntry;
  bindings: WorkerBindings;
  publicOrigin: string;
  hostname: string;
  port: number;
  assetsDirectory: string;
  trustedProxyIPs?: readonly string[];
  scheduled?: boolean;
}): Promise<{ port: number; close(): Promise<void> }> {
  const origin = new URL(options.publicOrigin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("Invalid account public origin.");
  if (
    origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
  )
    throw new Error("The account public origin must use HTTPS.");
  // Trust operator configuration, never Host headers or an origin supplied in an invitation.
  if (origin.protocol === "https:") options.bindings.ACCOUNT_INVITE_ORIGIN = origin.origin;
  else delete options.bindings.ACCOUNT_INVITE_ORIGIN;
  const assetsDirectory = await realpath(options.assetsDirectory);
  const proxies = new Set(options.trustedProxyIPs ?? []);
  if ([...proxies].some((ip) => !isIP(ip))) throw new Error("Trusted proxies must be explicit IP addresses.");
  const work = new Set<Promise<unknown>>();
  const waitUntil = (promise: Promise<unknown>) => {
    const tracked = promise
      .catch((error) => {
        logger.error("Account background operation failed.", { type: error instanceof Error ? error.name : "Unknown" });
      })
      .finally(() => work.delete(tracked));
    work.add(tracked);
  };
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort());
    let bodyTooLarge = false;
    try {
      const path = incoming.url ?? "/";
      if (!path.startsWith("/") || path.startsWith("//")) {
        outgoing.writeHead(400).end();
        return;
      }
      const url = new URL(path, origin);
      if (url.origin !== origin.origin) {
        outgoing.writeHead(400).end();
        return;
      }
      const headers = requestHeaders(incoming, proxies);
      const declared = headers.get("Content-Length");
      if (declared && Number(declared) > MAX_BODY_BYTES) {
        outgoing.writeHead(413, { Connection: "close" }).end();
        return;
      }
      const method = incoming.method ?? "GET";
      const iterator = incoming[Symbol.asyncIterator]();
      let received = 0;
      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                const next = await iterator.next();
                if (next.done) {
                  controller.close();
                  return;
                }
                const chunk = new Uint8Array(next.value);
                received += chunk.byteLength;
                if (received > MAX_BODY_BYTES) {
                  bodyTooLarge = true;
                  controller.error(new Error("Request body exceeds the account service limit."));
                  return;
                }
                controller.enqueue(chunk);
              },
            });
      const init = { method, headers, ...(body ? { body, duplex: "half" } : {}), signal: abort.signal };
      const request = new Request(url, init);
      const response =
        (await asset(request, assetsDirectory)) ??
        (await options.entry.fetch(request, options.bindings, { waitUntil }));
      await send(
        bodyTooLarge ? new Response(null, { status: 413, headers: { Connection: "close" } }) : response,
        outgoing,
        method === "HEAD",
      );
    } catch (error) {
      logger.error("Account request failed.", { type: error instanceof Error ? error.name : "Unknown" });
      if (!outgoing.headersSent)
        outgoing.writeHead(bodyTooLarge ? 413 : 500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      if (!outgoing.destroyed)
        outgoing.end(
          JSON.stringify({
            error: { code: "internal_error", message: sourceText("error.auth.serviceError") },
          }),
        );
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Account server did not bind its TCP port.");
  }
  const schedule =
    options.scheduled !== false && options.entry.scheduled
      ? setInterval(() => {
          if (options.entry.scheduled)
            waitUntil(
              options.entry.scheduled(
                { scheduledTime: Math.floor(Date.now() / 300_000) * 300_000, cron: "*/5 * * * *" },
                options.bindings,
              ),
            );
        }, 5 * 60_000)
      : null;
  schedule?.unref();
  return {
    port: address.port,
    async close() {
      if (schedule) clearInterval(schedule);
      await new Promise<void>((resolveClosed, reject) =>
        server.close((error) => (error ? reject(error) : resolveClosed())),
      );
      await Promise.allSettled([...work]);
    },
  };
}
