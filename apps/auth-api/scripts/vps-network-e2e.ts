// Public network checks from the operator's computer; no credentials or emails are used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connect } from "node:tls";

const HOST = "openbot.harpia.digital";
const OUT = resolve(import.meta.dirname, "../../../.openbot-build/vps-network-e2e");
const checks: { name: string; passed: boolean }[] = [];
async function check(name: string, operation: () => Promise<void>) {
  try {
    await operation();
    checks.push({ name, passed: true });
  } catch {
    checks.push({ name, passed: false });
  }
}
await check(
  "the public TURN UDP listener answers a matching STUN binding request",
  () =>
    new Promise<void>((done, reject) => {
      const socket = createSocket("udp4");
      const id = randomBytes(12);
      const body = Buffer.alloc(20);
      body.writeUInt16BE(1, 0);
      body.writeUInt32BE(0x2112a442, 4);
      id.copy(body, 8);
      const deadline = setTimeout(() => finish(new Error("UDP deadline")), 5000);
      const finish = (error?: Error) => {
        clearTimeout(deadline);
        socket.close();
        error ? reject(error) : done();
      };
      socket.once("error", finish);
      socket.once("message", (message) => {
        try {
          assert.equal(message.readUInt16BE(0), 0x0101);
          assert.equal(message.readUInt32BE(4), 0x2112a442);
          assert.ok(message.subarray(8, 20).equals(id));
          finish();
        } catch {
          finish(new Error("Invalid STUN response"));
        }
      });
      socket.send(body, 3478, HOST);
    }),
);
await check(
  "the public TURN TLS listener presents a valid certificate for the domain",
  () =>
    new Promise<void>((done, reject) => {
      const socket = connect({ host: HOST, port: 5349, servername: HOST });
      socket.setTimeout(5000, () => socket.destroy(new Error("TLS deadline")));
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        const valid = socket.authorized;
        socket.destroy();
        valid ? done() : reject(new Error("Untrusted TLS"));
      });
    }),
);
await mkdir(OUT, { recursive: true });
const passed = checks.every((item) => item.passed);
await writeFile(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ host: HOST, passed, checks, limits: "External STUN and TLS reachability only; authenticated TURN allocation is verified by the Signal health route. A real user WebRTC session remains separate." }, null, 2)}\n`,
);
process.stdout.write(`${passed ? "PASS" : "FAIL"} public VPS network E2E (${checks.length} checks)\n`);
if (!passed) process.exitCode = 1;
