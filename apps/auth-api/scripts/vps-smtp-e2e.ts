// Exercises the native VPS SMTP connector against a loopback-only TLS server.
// The report contains scenario names and safe outcome codes, never credentials or email content.
// Run: bun apps/auth-api/scripts/vps-smtp-e2e.ts
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { Effect, Result, Schema } from "effect";
import { prepareEmailCode, type SmtpConnector, sendPrivateEmail } from "../src/server/smtp-email-delivery";
import { vpsSmtpConnector } from "../src/vps/smtp-connector";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build", "vps-smtp-e2e");
const PORT = 465;
const SMTP_USERNAME = "smtp-e2e@example.test";
const RESEND_USERNAME = "resend";
const SMTP_PASSWORD = "local-fixture-password-only";
const SMTP_FROM = "no-reply@example.test";
const SMTP_TO = "recipient@example.test";
const OTP_FIXTURE = "2345-6789";
const checks: { name: string; passed: boolean; detail?: string }[] = [];
const SmtpClientOutput = Schema.Struct({
  kind: Schema.Literal("smtp-e2e-client"),
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
  connectorCalled: Schema.Boolean,
});

interface ServerState {
  tlsConnections: number;
  tlsHandshakeRejections: number;
  authenticated: boolean;
  authRejected: boolean;
  mailAccepted: boolean;
  recipientAccepted: boolean;
  messageAccepted: boolean;
  messageContainsFixtureCode: boolean;
  quitReceived: boolean;
  clientClosed: boolean;
  sockets: Set<TLSSocket>;
  clientClosedSignal: Promise<void>;
  signalClientClosed: () => void;
}

function serverState(): ServerState {
  let signalClientClosed = () => {};
  const clientClosedSignal = new Promise<void>((resolveSignal) => {
    signalClientClosed = resolveSignal;
  });
  return {
    tlsConnections: 0,
    tlsHandshakeRejections: 0,
    authenticated: false,
    authRejected: false,
    mailAccepted: false,
    recipientAccepted: false,
    messageAccepted: false,
    messageContainsFixtureCode: false,
    quitReceived: false,
    clientClosed: false,
    sockets: new Set(),
    clientClosedSignal,
    signalClientClosed,
  };
}

function recordCheck(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
}

function makeTlsServer(
  key: Buffer,
  certificate: Buffer,
  state: ServerState,
  rejectAuth: boolean,
  expectedUsername: string,
) {
  const server = createServer({ key, cert: certificate }, (socket: TLSSocket) => {
    state.tlsConnections += 1;
    state.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP local fixture\r\n");
    let pending = "";
    let message = "";
    let receivingMessage = false;
    socket.on("close", () => {
      state.sockets.delete(socket);
      state.clientClosed = true;
      state.signalClientClosed();
    });
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const lineEnd = pending.indexOf("\r\n");
        if (lineEnd < 0) break;
        const line = pending.slice(0, lineEnd);
        pending = pending.slice(lineEnd + 2);
        if (receivingMessage) {
          if (line === ".") {
            receivingMessage = false;
            state.messageAccepted = true;
            state.messageContainsFixtureCode = message.includes(OTP_FIXTURE);
            socket.write("250 2.0.0 accepted locally\r\n");
          } else {
            message += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        if (line.startsWith("EHLO ")) {
          socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 PIPELINING\r\n");
        } else if (line.startsWith("AUTH PLAIN ")) {
          const encoded = line.slice("AUTH PLAIN ".length);
          const [empty, username, password] = Buffer.from(encoded, "base64").toString("utf8").split("\0");
          const credentialsValid = empty === "" && username === expectedUsername && password === SMTP_PASSWORD;
          state.authenticated = credentialsValid && !rejectAuth;
          state.authRejected = !credentialsValid || rejectAuth;
          socket.write(state.authenticated ? "235 2.7.0 authenticated\r\n" : "535 5.7.8 authentication refused\r\n");
        } else if (line.startsWith("MAIL FROM:")) {
          state.mailAccepted = true;
          socket.write("250 2.1.0 sender accepted\r\n");
        } else if (line.startsWith("RCPT TO:")) {
          state.recipientAccepted = line.includes(`<${SMTP_TO}>`);
          socket.write(
            state.recipientAccepted ? "250 2.1.5 recipient accepted\r\n" : "550 5.1.1 recipient refused\r\n",
          );
        } else if (line === "DATA") {
          receivingMessage = true;
          socket.write("354 send local fixture message\r\n");
        } else if (line === "QUIT") {
          state.quitReceived = true;
          socket.write("221 2.0.0 closing locally\r\n");
        } else {
          socket.write("500 5.5.2 unsupported local fixture command\r\n");
        }
      }
    });
  });
  server.on("tlsClientError", (_error, socket) => {
    state.tlsHandshakeRejections += 1;
    if (!socket.destroyed) {
      state.sockets.add(socket);
      socket.once("close", () => state.sockets.delete(socket));
    }
  });
  return server;
}

async function startServer(key: Buffer, certificate: Buffer, rejectAuth = false, expectedUsername = SMTP_USERNAME) {
  const state = serverState();
  const server = makeTlsServer(key, certificate, state, rejectAuth, expectedUsername);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "localhost", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP fixture did not bind a TCP port.");
  return { server, state, port: address.port };
}

async function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function runClient(
  withLocalCa: boolean,
  mode: "send" | "reject-auth" | "resend" | "resend-other-host" | "resend-crlf",
  port: number,
): Promise<{
  exitCode: number | null;
  status: string | null;
  failure: string | null;
  connectorCalled: boolean;
}> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  if (withLocalCa) env.NODE_EXTRA_CA_CERTS = process.env.VPS_SMTP_E2E_CA;
  env.VPS_SMTP_E2E_PORT = String(port);
  const child = spawn(process.execPath, [import.meta.filename, "--smtp-client", mode], { env });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", () => resolveExit());
  });
  const resultLine = stdout
    .split("\n")
    .map((line) => {
      try {
        return Schema.decodeUnknownSync(SmtpClientOutput)(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .find((value) => value !== null);
  if (resultLine === null || typeof resultLine !== "object")
    return { exitCode: child.exitCode, status: null, failure: null, connectorCalled: false };
  return {
    exitCode: child.exitCode,
    status: resultLine.status,
    failure: resultLine.failure,
    connectorCalled: resultLine.connectorCalled,
  };
}

function localConnector(port: number, expectedHostname: string, calls: { count: number }): SmtpConnector {
  return (address, options) => {
    calls.count += 1;
    if (address.hostname !== expectedHostname || address.port !== PORT) {
      throw new Error("Unexpected SMTP destination in local fixture.");
    }
    return vpsSmtpConnector({ hostname: "localhost", port }, options);
  };
}

async function runSmtpClient(
  mode: "send" | "reject-auth" | "resend" | "resend-other-host" | "resend-crlf",
  targetPort: number,
): Promise<void> {
  const config =
    mode === "resend"
      ? { host: "smtp.resend.com", port: PORT, username: RESEND_USERNAME, password: SMTP_PASSWORD, from: SMTP_FROM }
      : mode === "resend-other-host"
        ? { host: "smtp.other.test", port: PORT, username: RESEND_USERNAME, password: SMTP_PASSWORD, from: SMTP_FROM }
        : mode === "resend-crlf"
          ? {
              host: "smtp.resend.com",
              port: PORT,
              username: `${RESEND_USERNAME}\r\nBcc: injected@example.test`,
              password: SMTP_PASSWORD,
              from: SMTP_FROM,
            }
          : {
              host: "localhost",
              port: PORT,
              username: SMTP_USERNAME,
              password: SMTP_PASSWORD,
              from: SMTP_FROM,
            };
  const connectorCalls = { count: 0 };
  const expectedHostname = mode === "resend" || mode === "resend-crlf" ? "smtp.resend.com" : config.host;
  try {
    const prepared = await Effect.runPromise(
      prepareEmailCode({ email: SMTP_TO, code: OTP_FIXTURE, expiresAt: Date.now() + 10 * 60_000 }),
    );
    const result = await Effect.runPromise(
      Effect.result(sendPrivateEmail(config, prepared, localConnector(targetPort, expectedHostname, connectorCalls))),
    );
    const status = Result.isSuccess(result) ? "sent" : "rejected";
    const failure =
      Result.isFailure(result) && /^smtp_[a-z_]+$/u.test(result.failure.message)
        ? result.failure.message
        : Result.isFailure(result)
          ? "smtp_unexpected_failure"
          : null;
    process.stdout.write(
      `${JSON.stringify({ kind: "smtp-e2e-client", mode, status, failure, connectorCalled: connectorCalls.count > 0 })}\n`,
    );
  } catch {
    process.stdout.write(
      `${JSON.stringify({ kind: "smtp-e2e-client", mode, status: "error", failure: "client_error", connectorCalled: connectorCalls.count > 0 })}\n`,
    );
    process.exitCode = 1;
  }
}

async function generateCertificate(directory: string): Promise<{ key: Buffer; certificate: Buffer }> {
  const configPath = join(directory, "openssl.cnf");
  const keyPath = join(directory, "localhost.key");
  const certificatePath = join(directory, "localhost.crt");
  await writeFile(
    configPath,
    [
      "[req]",
      "prompt = no",
      "distinguished_name = subject",
      "x509_extensions = server_cert",
      "[subject]",
      "CN = localhost",
      "[server_cert]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
      "subjectAltName = @names",
      "[names]",
      "DNS.1 = localhost",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-config",
      configPath,
    ],
    { stdio: "ignore" },
  );
  return { key: await readFile(keyPath), certificate: await readFile(certificatePath) };
}

async function runE2e(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vps-smtp-e2e-"));
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const startedAt = new Date().toISOString();
  let outcomeError: string | undefined;
  let stage = "certificate";
  try {
    const { key, certificate } = await generateCertificate(temporaryRoot);
    process.env.VPS_SMTP_E2E_CA = join(temporaryRoot, "localhost.crt");

    stage = "listen-untrusted-test";
    let server = await startServer(key, certificate);
    servers.push(server);
    stage = "run-untrusted-client";
    const untrustedResult = await runClient(false, "send", server.port);
    recordCheck(
      "TLS rejects the temporary certificate when the child process does not trust its CA",
      untrustedResult.exitCode === 0 &&
        untrustedResult.status === "rejected" &&
        untrustedResult.failure === "smtp_transport_failed" &&
        server.state.tlsHandshakeRejections > 0 &&
        server.state.tlsConnections === 0,
    );
    stage = "close-untrusted-server";
    await stopServer(server.server);
    servers.splice(servers.indexOf(server), 1);

    stage = "listen-trusted-test";
    server = await startServer(key, certificate);
    servers.push(server);
    stage = "run-trusted-client";
    const acceptedResult = await runClient(true, "send", server.port);
    await server.state.clientClosedSignal;
    recordCheck(
      "trusted TLS, SMTP authentication and private-code message complete and close",
      acceptedResult.exitCode === 0 &&
        acceptedResult.status === "sent" &&
        acceptedResult.failure === null &&
        server.state.tlsConnections === 1 &&
        server.state.authenticated &&
        server.state.mailAccepted &&
        server.state.recipientAccepted &&
        server.state.messageAccepted &&
        server.state.messageContainsFixtureCode &&
        server.state.quitReceived &&
        server.state.clientClosed,
    );
    stage = "close-trusted-server";
    await stopServer(server.server);
    servers.splice(servers.indexOf(server), 1);

    stage = "listen-auth-rejection-test";
    server = await startServer(key, certificate, true);
    servers.push(server);
    stage = "run-auth-rejection-client";
    const rejectedResult = await runClient(true, "reject-auth", server.port);
    await server.state.clientClosedSignal;
    recordCheck(
      "SMTP authentication refusal is returned as a safe stage code and closes",
      rejectedResult.exitCode === 0 &&
        rejectedResult.status === "rejected" &&
        rejectedResult.failure === "smtp_auth_failed" &&
        server.state.authRejected &&
        !server.state.messageAccepted &&
        server.state.clientClosed,
    );
    stage = "close-auth-rejection-server";
    await stopServer(server.server);
    servers.splice(servers.indexOf(server), 1);

    stage = "listen-resend-test";
    server = await startServer(key, certificate, false, RESEND_USERNAME);
    servers.push(server);
    stage = "run-resend-client";
    const resendResult = await runClient(true, "resend", server.port);
    await server.state.clientClosedSignal;
    recordCheck(
      "Resend bare username is accepted only for smtp.resend.com on port 465 and reroutes to local TLS",
      resendResult.exitCode === 0 &&
        resendResult.status === "sent" &&
        resendResult.failure === null &&
        resendResult.connectorCalled &&
        server.state.tlsConnections === 1 &&
        server.state.authenticated &&
        server.state.messageAccepted &&
        server.state.messageContainsFixtureCode &&
        server.state.clientClosed,
    );

    stage = "run-resend-other-host-client";
    const otherHostResult = await runClient(true, "resend-other-host", server.port);
    recordCheck(
      "bare Resend username is rejected for every other SMTP hostname before connecting",
      otherHostResult.exitCode === 0 &&
        otherHostResult.status === "rejected" &&
        otherHostResult.failure === "smtp_invalid_username" &&
        !otherHostResult.connectorCalled &&
        server.state.tlsConnections === 1,
    );

    stage = "run-resend-crlf-client";
    const crlfResult = await runClient(true, "resend-crlf", server.port);
    recordCheck(
      "Resend username with CRLF is rejected before connecting",
      crlfResult.exitCode === 0 &&
        crlfResult.status === "rejected" &&
        crlfResult.failure === "smtp_invalid_username" &&
        !crlfResult.connectorCalled &&
        server.state.tlsConnections === 1,
    );
    stage = "close-resend-server";
    await stopServer(server.server);
    servers.splice(servers.indexOf(server), 1);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "no_code";
    outcomeError = `${stage}:${error instanceof Error ? error.name : "UnknownError"}:${code}`;
    recordCheck("local SMTP E2E fixture completes", false, outcomeError);
  } finally {
    for (const server of servers) {
      try {
        for (const socket of server.state.sockets) socket.destroy();
      } catch {
        // Keep going to close the listener if an individual TLS socket cannot be destroyed.
      }
      try {
        await stopServer(server.server);
      } catch {
        // A failed scenario may already have closed the listener.
      }
    }
    delete process.env.VPS_SMTP_E2E_CA;
    await writeFile(
      join(OUT, "report.json"),
      `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), checks }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const failures = checks.filter(({ passed }) => !passed);
  process.stdout.write(`${failures.length ? "FAIL" : "PASS"} VPS SMTP E2E (${checks.length} checks)\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[2] === "--smtp-client") {
  const modeArgument = process.argv[3];
  const mode =
    modeArgument === "reject-auth" ||
    modeArgument === "resend" ||
    modeArgument === "resend-other-host" ||
    modeArgument === "resend-crlf"
      ? modeArgument
      : "send";
  void runSmtpClient(mode, Number(process.env.VPS_SMTP_E2E_PORT));
} else {
  void runE2e();
}
