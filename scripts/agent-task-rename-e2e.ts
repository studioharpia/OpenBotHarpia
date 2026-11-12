// Exercises rename_task on the real SQLite store, mailbox and task service, without provider calls.
// Run: bun scripts/agent-task-rename-e2e.ts
// Writes .openbot-build/agent-task-rename-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { discoverTools } from "../src/backend/agent/tool-catalog";
import { AgentStore } from "../src/backend/agent-store";
import { AgentTasks, RENAME_TASK_TOOL } from "../src/backend/agent-tasks/agent-tasks";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const out = resolve(".openbot-build/agent-task-rename-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-task-rename-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const agents = new AgentStore(state, join(root, "home"), database);
const mailbox = new MailboxStore(state, agents.sharedRoot, database);
const conversation = new ConversationRuntime(
  agents,
  () => {},
  () => agents.list(),
);
const threads = new AgentThreadStore(database);
const events: AgentEvent[] = [];
const tasks = new AgentTasks({
  store: threads,
  mailbox,
  conversation,
  hooks: {
    transfer: () => Effect.die(new Error("Transfer is not used by the rename flow.")),
    emit: (event) => events.push(event),
    agent: (id) => agents.list().find((agent) => agent.id === id),
    hold: () => null,
    queued: () => {},
    turnActive: () => false,
    archived: () => Effect.void,
  },
});
const report: { passed: boolean; checks: string[] } = { passed: false, checks: [] };
const params = (tool: string, args: unknown) => ({
  threadId: "rename-e2e-thread",
  turnId: "rename-e2e-turn",
  callId: crypto.randomUUID(),
  namespace: "openbot",
  tool,
  arguments: args,
});
const call = (agentId: string, args: unknown, inExecutionThread = false) =>
  runCauseEffect(tasks.handleTool(params(RENAME_TASK_TOOL, args), { agentId, inExecutionThread }));
try {
  await runCauseEffect(agents.initialize());
  await runCauseEffect(mailbox.initialize());
  const owner = await runCauseEffect(
    agents.createAgent({
      name: "Owner",
      description: "Rename task check",
      avatarSeed: "rename-owner",
      avatarHue: null,
    }),
  );
  const other = await runCauseEffect(
    agents.createAgent({ name: "Other", description: "Ownership check", avatarSeed: "rename-other", avatarHue: null }),
  );
  const own = tasks.create(owner.id, "Original", "agent");
  const foreign = tasks.create(other.id, "Foreign", "agent");
  const user = tasks.create(owner.id, "User thread", "user");
  const routine = tasks.routineThread(owner.id, "rename-e2e-routine", "Routine thread");
  assert.ok(routine);
  await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "agent", agentId: owner.id },
      taskId: own.taskId,
      recipientAgentIds: [owner.id],
      text: "Keep this queued brief",
      replyToMessageId: null,
      idempotencyKey: "rename-brief",
    }),
  );
  const before = tasks.snapshot(owner.id).tasks.find((task) => task.id === own.taskId);
  const beforeChat = tasks.read(owner.id, own.taskId);
  assert.ok(before);
  assert.equal(before.state, "queued");
  const renamed = await call(owner.id, { taskId: own.taskId, title: "  Renamed by agent  " });
  assert.equal(renamed?.success, true);
  const after = tasks.snapshot(owner.id).tasks.find((task) => task.id === own.taskId);
  assert.ok(after);
  assert.equal(after.title, "Renamed by agent");
  const unchanged = ({ title: _title, updatedAt: _updatedAt, ...rest }: typeof after) => rest;
  assert.deepEqual(unchanged(after), unchanged(before));
  assert.deepEqual(tasks.read(owner.id, own.taskId), beforeChat);
  assert.equal(threads.task(own.taskId)?.titleSource, "agent");
  const change = events.find(
    (event) =>
      event.type === "agent-tasks-changed" &&
      event.snapshot.tasks.some((task) => task.id === own.taskId && task.title === after.title),
  );
  assert.ok(change);
  report.checks.push(
    "Tool renames its creator's task, trims the title, keeps queue/conversation/state/identity and emits the task-list update.",
  );
  const count = events.length;
  assert.equal((await call(owner.id, { taskId: own.taskId, title: after.title }))?.success, true);
  assert.equal(events.length, count);
  report.checks.push("Identical retry succeeds without another change event.");
  for (const forbidden of [foreign, user, routine]) {
    const original = threads.task(forbidden.taskId);
    assert.equal((await call(owner.id, { taskId: forbidden.taskId, title: "Forbidden" }))?.success, false);
    assert.deepEqual(threads.task(forbidden.taskId), original);
  }
  report.checks.push("Foreign agent, user-created and routine tasks are refused without changing stored data.");
  for (const args of [
    {},
    { taskId: own.taskId, title: " " },
    { taskId: own.taskId, title: "x".repeat(121) },
    { taskId: "missing", title: "Name" },
    { taskId: own.taskId, title: "Name", agentId: other.id },
  ]) {
    assert.equal((await call(owner.id, args))?.success, false);
  }
  assert.equal(threads.task(own.taskId)?.title, after.title);
  report.checks.push("Malformed input, blank/oversize title, unknown task and forged agentId are rejected.");
  assert.equal((await call(owner.id, { taskId: own.taskId, title: "Renamed from own thread" }, true))?.success, true);
  report.checks.push("The same authenticated agent can rename from a task execution context.");
  tasks.rename(tasks.require(owner.id, own.taskId), "Person renamed");
  assert.equal(threads.task(own.taskId)?.titleSource, "user");
  assert.equal((await call(owner.id, { taskId: own.taskId, title: "Persisted agent title" }))?.success, true);
  database.close();
  const unavailable = await call(owner.id, { taskId: own.taskId, title: "Must not persist" });
  assert.equal(unavailable?.success, false);
  assert.ok(JSON.stringify(unavailable).includes("could not rename"));
  assert.ok(!JSON.stringify(unavailable).includes(state));
  report.checks.push("A closed database returns a safe tool failure without internal paths or mutation.");
  await runCauseEffect(database.initialize());
  assert.equal(threads.task(own.taskId)?.title, "Persisted agent title");
  assert.equal(threads.task(own.taskId)?.titleSource, "agent");
  report.checks.push(
    "Existing manual rename retains user provenance; tool rename retains agent provenance after reopening SQLite.",
  );
  const described = discoverTools(params("tool_describe", { name: "openbot.rename_task" }), "codex");
  assert.ok(described.tools.some((tool) => tool.name === "openbot.rename_task" && "inputSchema" in tool));
  assert.ok(JSON.stringify(described).includes("history_search"));
  report.checks.push("The real tool catalog discovers rename_task and its task-ID guidance.");
  report.passed = true;
} finally {
  conversation.dispose();
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
