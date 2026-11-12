// Real runtime and SQLite: provider session aliases must keep a running chat, and paged reads must
// reach long turns even when a newer standalone message follows them. No provider or network calls.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { DeltaBuffer } from "../src/backend/agent/delta-buffer";
import { AgentStore } from "../src/backend/agent-store";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const out = resolve(".openbot-build/conversation-session-cache-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-conversation-cache-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);
const events: AgentEvent[] = [];
const runtime = new ConversationRuntime(
  store,
  (event) => events.push(event),
  () => store.list(),
);
const deltas = new DeltaBuffer({ conversation: runtime, database, hooks: { emit: (event) => events.push(event) } });
const checks: string[] = [];
const report = { passed: false, checks, error: "" };
try {
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(
    store.createAgent({
      name: "History fixture",
      description: "Temporary E2E",
      avatarSeed: "history",
      avatarHue: null,
    }),
  );
  const threadId = store.ensureThreadIdNow(agent.id);
  const turnId = "long-turn";
  const externalId = "provider-session";
  const messages: ConversationMessage[] = Array.from({ length: 121 }, (_, index) => ({
    id: `step-${index}`,
    turnId,
    author: index === 0 ? "user" : "assistant",
    text: `Step ${index}`,
    status: "completed",
    itemType: index === 0 ? undefined : "commentary",
    createdAt: new Date(Date.UTC(2030, 0, 1, 10, 0, index)).toISOString(),
  }));
  messages.push({
    id: "standalone",
    author: "agent",
    text: "Independent reply",
    status: "completed",
    createdAt: "2030-01-01T10:00:30.000Z",
  });
  const snapshot: ConversationSnapshot = { agentId: agent.id, threadId, activeTurnId: turnId, revision: 0, messages };
  snapshot.revision = database.persistConversation(snapshot, "fixture.created").revision;
  runtime.bindThread(externalId, agent.id, threadId);
  runtime.setSnapshot(agent.id, snapshot);
  const original = runtime.ensureSnapshot(agent.id, threadId);
  for (let index = 0; index < 6; index++) {
    const current = runtime.ensureSnapshot(agent.id, index % 2 === 0 ? externalId : threadId);
    assert.equal(current, original, "Public and provider ids must retain the live object.");
    assert.equal(current.messages.length, 122);
    assert.equal(current.activeTurnId, turnId);
  }
  report.checks.push("Alternating public/provider ids preserves all 122 messages and the active turn.");
  const streamed = original.messages.find((message) => message.id === "step-120");
  assert(streamed);
  streamed.status = "streaming";
  streamed.text += " — streamed";
  deltas.buffer({
    agentId: agent.id,
    externalThreadId: externalId,
    publicThreadId: threadId,
    turnId,
    messageId: streamed.id,
    text: " — streamed",
    createdAt: streamed.createdAt,
  });
  deltas.flushTurn(turnId);
  runtime.emitConversation(runtime.ensureSnapshot(agent.id, externalId));
  const published = events.findLast((event) => event.type === "conversation");
  assert(published?.type === "conversation");
  assert.equal(published.snapshot.messages.length, 122);
  assert.equal(published.snapshot.messages.find((message) => message.id === streamed.id)?.text, streamed.text);
  assert.equal(database.readConversation(agent.id, threadId).messages.length, 122);
  report.checks.push("A real delta flush and following snapshot keep the history and durable streamed text.");
  const latest = database.readConversationPage(agent.id, threadId, { type: "latest" }, 50);
  assert.equal(latest.messages.length, 100);
  assert(latest.messages.some((message) => message.id === "step-120"));
  assert(latest.messages.some((message) => message.id === "standalone"));
  const loaded = new Set(latest.messages.map((message) => message.id));
  let cursor = latest.pageInfo.olderCursor;
  while (cursor) {
    const older = database.readConversationPage(agent.id, threadId, { type: "before", cursor }, 50);
    for (const message of older.messages) {
      assert(!loaded.has(message.id), "Adjacent pages must not repeat messages.");
      loaded.add(message.id);
    }
    cursor = older.pageInfo.olderCursor;
  }
  assert.equal(loaded.size, 122);
  const around = database.readConversationPage(agent.id, threadId, { type: "around", messageId: "step-60" }, 50);
  assert(around.messages.some((message) => message.id === "step-60"));
  assert(around.messages.length <= 100);
  report.checks.push(
    "Latest, older and around pages reach the long turn, obey the wire limit, and cover all messages once.",
  );
  const task = new AgentThreadStore(database).create({
    agentId: agent.id,
    origin: "user",
    title: "Side fixture",
    titleSource: "auto",
  });
  runtime.registerTaskThread(agent.id, task.threadId);
  runtime.bindThread("side-provider", agent.id, task.threadId);
  const side = runtime.ensureSnapshot(agent.id, "side-provider");
  assert.equal(side.threadId, task.threadId);
  assert.notEqual(side, original);
  assert.equal(runtime.ensureSnapshot(agent.id, externalId), original);
  report.checks.push("A side task's provider alias stays isolated from its agent's main chat.");
  runtime.unbindThread(externalId);
  runtime.bindThread("replacement-session", agent.id, threadId);
  assert.equal(runtime.ensureSnapshot(agent.id, "replacement-session"), original);
  report.checks.push("Rebinding a provider session preserves the agent's conversation identity and messages.");
  report.passed = true;
} catch (failure) {
  report.error = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
} finally {
  deltas.dispose();
  runtime.dispose();
  database.close();
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
