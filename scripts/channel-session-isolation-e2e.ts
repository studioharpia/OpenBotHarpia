// Runs real AgentService, scheduler, SQLite and Codex adapter against a controlled provider process. No live account or installed app is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { Effect } from "effect";

import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";

const OUT = resolve(import.meta.dirname, "../.openbot-build/channel-session-isolation-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-channel-create-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const fakeCodex = join(root, "codex");
const fakeLog = join(root, "codex.jsonl");

// Before the service modules load: the Codex process and the stores read the home folder.

process.env.OPENBOT_CODEX_PATH = fakeCodex;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");

const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

const CALL_MARK = "CHANNEL-CALL";
const PERSON = { id: "local", name: "Alex" };
/** A team member, whose app has only what the Team API gives it. */
const MEMBER = { id: "member-remote", name: "Sam" };
/**
 * A Codex app-server with the methods that the service calls. A turn whose input has
 * `CHANNEL-CALL <<ARGS{"__tool":"…",…}ARGS>>` calls `openbot.<__tool>` with the rest of that JSON
 * through `tool_call`, logs the result, and ends. A channel packet also repeats earlier requests, so
 * the last call in the input is the current assignment. Other turns answer "Done.".
 */
const FAKE_CODEX = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require("node:fs");
const timers = new Map();
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\\n");
  process.exit(0);
}
const LOG = ${JSON.stringify(fakeLog)};
const config = { config: { mcp_servers: {} }, layers: [{ name: { type: "user", file: "/fake/.codex/config.toml", profile: null }, version: "1", config: { mcp_servers: {} } }] };
let buffer = "";
let threads = 0;
let turns = 0;
/** Tool request id -> the turn that waits for its result. */
const waiting = new Map();
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const finish = (threadId, turnId) => {
  const item = { type: "agentMessage", id: "message-" + turnId, text: "Done.", phase: "final_answer" };
  write({ method: "item/completed", params: { threadId, turnId, item } });
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
};
const answer = (message) => {
  const params = message.params || {};
  switch (message.method) {
    case "initialize": return write({ id: message.id, result: {} });
    case "account/read": return write({ id: message.id, result: { account: { type: "chatgpt", email: "codex@example.com" } } });
    case "account/rateLimits/read": return write({ id: message.id, result: { rateLimits: { limitId: "codex", primary: null, secondary: null }, rateLimitsByLimitId: null } });
    case "model/list": return write({ id: message.id, result: { data: [{ model: "gpt-6-luna", displayName: "GPT-6 Luna" }] } });
    case "plugin/list": return write({ id: message.id, result: { marketplaces: [] } });
    case "config/read": return write({ id: message.id, result: config });
    case "config/batchWrite": return write({ id: message.id, result: {} });
    case "thread/start": return write({ id: message.id, result: { thread: { id: "thread-" + (++threads), turns: [] } } });
    case "thread/resume": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "thread/unsubscribe": return write({ id: message.id, result: { status: "Unsubscribed" } });
    case "thread/turns/list":
    case "thread/items/list": return write({ id: message.id, result: { data: [], nextCursor: null } });
    case "thread/read": return write({ id: message.id, result: { thread: { id: params.threadId, turns: [] } } });
    case "turn/start": {
      const turnId = "turn-" + (++turns);
      const text = (params.input || []).map((item) => item.text || "").join("\\n");
      write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      write({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } });
      log({ type: "start", threadId: params.threadId, turnId, text, at: Date.now() });
      const marks = [...text.matchAll(/SESSION_(HOLD|NEXT)_([A-Z]+)/g)];
      const mark = marks.at(-1);
      if (mark && mark[1] === "HOLD") {
        const timer = setInterval(() => {
          if (!existsSync(LOG + "." + mark[2])) return;
          clearInterval(timer);
          timers.delete(turnId);
          finish(params.threadId, turnId);
        }, 25);
        timers.set(turnId, timer);
        return;
      }
      const calls = text.includes(${JSON.stringify(CALL_MARK)}) ? [...text.matchAll(/<<ARGS([\\s\\S]*?)ARGS>>/g)] : [];
      const match = calls.at(-1);
      if (!match) return setTimeout(() => finish(params.threadId, turnId), 20);
      const id = "tool-" + turnId;
      waiting.set(id, { threadId: params.threadId, turnId });
      // The packet carries the request as JSON text, so its quotes arrive escaped.
      const { __tool, ...args } = JSON.parse(match[1].replace(/\\\\"/g, '"'));
      return write({
        id,
        method: "item/tool/call",
        params: {
          threadId: params.threadId,
          turnId,
          callId: "call-" + turnId,
          namespace: "openbot",
          tool: "tool_call",
          arguments: { name: "openbot." + __tool, arguments: args },
        },
      });
    }
    case "turn/interrupt": {
      clearInterval(timers.get(params.turnId));
      timers.delete(params.turnId);
      log({ type: "interrupt", ...params, at: Date.now() });
      write({ id: message.id, result: {} });
      return write({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } });
    }
    default:
      return write({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) answer(message);
      else if (!message.method && waiting.has(message.id)) {
        const turn = waiting.get(message.id);
        waiting.delete(message.id);
        log({ turnId: turn.turnId, result: message.result ?? null, error: message.error ?? null });
        finish(turn.threadId, turn.turnId);
      }
    }
    newline = buffer.indexOf("\\n");
  }
});
`;

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
  shareTab: () => undefined,
  unshareThread: () => undefined,
  agentTab: () => null,
};

/** Waits for a state of the service or the fake's log. */
async function waitFor<T>(label: string, read: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  timezone: () => "UTC",
  channelPersonAgentLevel: () => "manage",
  channelRemotePerson: (personId) => personId === MEMBER.id,
});

const report: {
  passed: boolean;
  checks: string[];
  error: string;
  starts: { threadId: string; turnId: string; text: string }[];
} = { passed: false, checks: [], error: "", starts: [] };
const logs = () => {
  try {
    return readFileSync(fakeLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
try {
  process.env.OPENBOT_EXECUTION_CONCURRENCY = "6";
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Jeremias",
      description: "Session check",
      avatarSeed: "session",
      avatarHue: null,
      initialMessage: "Hello.",
    }),
  );
  await waitFor("initial chat", () => agents.listQueue(agent.id).deliveries.every((d) => d.status === "completed"));
  const ids: string[] = [];
  for (const name of ["A", "B", "C", "D", "E", "F", "G"]) {
    const id = randomUUID();
    ids.push(id);
    await runCauseEffect(
      agents.channels.command(
        {
          type: "save",
          operationId: randomUUID(),
          channelId: id,
          draft: {
            name,
            title: "Session check",
            instructions: "Keep context",
            members: [{ agentId: agent.id }],
            leadAgentId: agent.id,
          },
        },
        PERSON,
      ),
    );
    await runCauseEffect(
      agents.channels.command(
        {
          type: "send",
          operationId: randomUUID(),
          channelId: id,
          text: `SESSION_HOLD_${name}`,
          recipientAgentId: agent.id,
          replyToMessageId: null,
          attachmentDraftIds: [],
        },
        PERSON,
      ),
    );
  }
  await waitFor("six channel turns overlap", () =>
    ids.slice(0, 6).every((id) => agents.channels.store.tasks(id).some((t) => t.state === "running")),
  );
  const starts = logs().filter((l) => l.type === "start" && l.text.includes("SESSION_HOLD_"));
  assert.equal(new Set(starts.map((s) => s.threadId)).size, 6);
  report.checks.push("Six channels of the same agent overlap on six distinct provider sessions (limit 6).");
  const first = ids[0];
  const second = ids[1];
  assert.ok(first && second);
  const firstStart = starts.find((item) => item.text.includes("SESSION_HOLD_A"));
  for (const start of starts) {
    const own = start.text.match(/SESSION_HOLD_([A-Z])/g);
    assert.equal(new Set(own).size, 1, "A channel packet must not contain another channel's request.");
  }
  const task = agents.channels.store.tasks(first)[0];
  assert.ok(task);
  await runCauseEffect(
    agents.channels.command(
      { type: "stop", operationId: randomUUID(), channelId: first, taskId: task.id, recipientAgentId: null },
      PERSON,
    ),
  );
  await waitFor("one interrupt", () => logs().find((l) => l.type === "interrupt"));
  assert.equal(logs().filter((l) => l.type === "interrupt").length, 1);
  assert.equal(logs().find((l) => l.type === "interrupt").threadId, firstStart.threadId);
  await runCauseEffect(
    agents.channels.command(
      { type: "cancel", operationId: randomUUID(), channelId: first, taskId: task.id, recipientAgentId: null },
      PERSON,
    ),
  );
  assert.ok(agents.channels.store.tasks(second).some((t) => t.state === "running"));
  report.checks.push("Cancellation interrupts only channel A; channel B remains running.");
  await waitFor("seventh channel takes the freed slot", () =>
    logs().find((l) => l.type === "start" && l.text.includes("SESSION_HOLD_G")),
  );
  const seventh = logs().find((l) => l.type === "start" && l.text.includes("SESSION_HOLD_G"));
  assert.ok(seventh.at >= logs().find((l) => l.type === "interrupt").at);
  report.checks.push("Channel G waits for a free slot when the configured limit is six.");
  for (const name of ["B", "C", "D", "E", "F", "G"]) writeFileSync(`${fakeLog}.${name}`, "release");
  await waitFor("other tasks finish", () =>
    ids.slice(1).every((id) => agents.channels.store.tasks(id).every((t) => t.state === "completed")),
  );
  const context = agents.channels.store.context(second, agent.id).threadId;
  await runCauseEffect(
    agents.channels.command(
      {
        type: "send",
        operationId: randomUUID(),
        channelId: second,
        text: "SESSION_NEXT_B",
        recipientAgentId: agent.id,
        replyToMessageId: null,
        attachmentDraftIds: [],
      },
      PERSON,
    ),
  );
  await waitFor(
    "continuation finishes",
    () =>
      logs().some((l) => l.type === "start" && l.text.includes("SESSION_NEXT_B")) &&
      agents.channels.store.tasks(second).every((t) => t.state === "completed"),
  );
  assert.equal(agents.channels.store.context(second, agent.id).threadId, context);
  const next = logs().find((l) => l.type === "start" && l.text.includes("SESSION_NEXT_B"));
  const original = starts.find((l) => l.text.includes("SESSION_HOLD_B"));
  assert.equal(next.threadId, original.threadId);
  for (const id of ids.slice(1))
    assert.ok(agents.channels.store.messages(id).some((m) => m.author.id === agent.id && m.message.text === "Done."));
  report.checks.push("Continuation reuses B's provider session; completed replies persist in their own channels.");
  report.starts = logs()
    .filter((l) => l.type === "start")
    .map(({ threadId, turnId, text }) => ({ threadId, turnId, text }));
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ ...report, starts: report.starts.length })}\n`);
}
