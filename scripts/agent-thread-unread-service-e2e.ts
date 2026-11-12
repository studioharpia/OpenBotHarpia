// Real agent/task services, event store and SQLite. Browser and providers are not used by this flow.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationSnapshot } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { ConversationReadStore } from "../src/backend/conversation-read-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const unused = () => Effect.die(new Error("Browser is not used by this flow."));
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
  shareTab: () => {},
  unshareThread: () => {},
  agentTab: () => null,
};
const root = await mkdtemp(join(tmpdir(), "openbot-task-unread-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const store = new AgentStore(state, join(root, "home"), database);
const mailbox = new MailboxStore(state, store.sharedRoot, database);
const service = new AgentService({ store, mailbox, browser });
const checks: string[] = [];
let passed = false;
let error = "";
try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const owner = await runCauseEffect(
    store.createAgent({ name: "Owner", description: "Unread fixture", avatarSeed: "unread", avatarHue: null }),
  );
  const other = await runCauseEffect(
    store.createAgent({ name: "Other", description: "Isolation fixture", avatarSeed: "other", avatarHue: null }),
  );
  const threads = new AgentThreadStore(database);
  const task = threads.create({
    agentId: owner.id,
    origin: "user",
    title: "Unread fixture",
    titleSource: "auto",
  });
  const foreign = threads.create({
    agentId: other.id,
    origin: "user",
    title: "Other fixture",
    titleSource: "auto",
  });
  const snapshot: ConversationSnapshot = {
    agentId: owner.id,
    threadId: task.threadId,
    activeTurnId: null,
    revision: 0,
    messages: [1, 2].map((index) => ({
      id: `answer-${index}`,
      turnId: `turn-${index}`,
      author: "assistant",
      source: "assistant",
      text: `Answer ${index}`,
      status: "completed",
      createdAt: `2031-01-01T10:0${index}:00.000Z`,
    })),
  };
  database.persistConversation(snapshot, "fixture.created");
  const input = { agentId: owner.id, taskId: task.taskId };
  service.markTaskRead({ ...input, throughMessageId: "answer-2" }, "reader-a");
  service.markTaskRead({ ...input, throughMessageId: "answer-2" }, "reader-b");
  const unread = service.markTaskUnread({ ...input, fromMessageId: "answer-1" }, "reader-a");
  assert.equal(unread.unreadCount, 2);
  assert.equal(unread.firstUnreadMessageId, "answer-1");
  assert.equal(service.listTaskReads(owner.id, "reader-b").find((r) => r.taskId === task.taskId)?.unreadCount, 0);
  checks.push("Rewinding reader A restores the selected and following answers; reader B remains read.");
  assert.throws(() => service.markTaskUnread({ ...input, fromMessageId: "foreign-message" }, "reader-a"));
  assert.throws(() =>
    service.markTaskUnread({ ...input, taskId: foreign.taskId, fromMessageId: "answer-1" }, "reader-a"),
  );
  assert.equal(service.listTaskReads(owner.id, "reader-a").find((r) => r.taskId === task.taskId)?.unreadCount, 2);
  checks.push("An unavailable message and a foreign agent's task are refused without moving the valid cursor.");
  await runCauseEffect(service.setTaskMessageReaction({ ...input, messageId: "answer-1", emoji: "👍" }));
  assert.equal(service.readTask(owner.id, task.taskId).messages.find((m) => m.id === "answer-1")?.reaction, "👍");
  await runCauseEffect(service.setTaskMessageReaction({ ...input, messageId: "answer-1", emoji: null }));
  assert.equal(service.readTask(owner.id, task.taskId).messages.find((m) => m.id === "answer-1")?.reaction, null);
  checks.push("Task reaction and removal persist without a main-chat mailbox merge.");
  service.markTaskRead({ ...input, throughMessageId: "answer-2" }, "reader-a");
  assert.equal(service.listTaskReads(owner.id, "reader-a").find((r) => r.taskId === task.taskId)?.unreadCount, 0);
  service.markTaskUnread({ ...input, fromMessageId: "answer-2" }, "reader-a");
  await runCauseEffect(service.stop());
  database.close();
  const reopened = new OpenBotDatabase(state);
  try {
    await runCauseEffect(reopened.initialize());
    const reads = new ConversationReadStore(reopened);
    assert.equal(reads.readStateForThread("reader-a", task.threadId).unreadCount, 1);
    assert.equal(reads.readStateForThread("reader-a", task.threadId).firstUnreadMessageId, "answer-2");
    assert.equal(reads.readStateForThread("reader-b", task.threadId).unreadCount, 0);
    assert.equal(reopened.readConversation(owner.id, task.threadId).messages.length, 2);
  } finally {
    reopened.close();
  }
  checks.push(
    "Read/unread reverse actions and the per-reader boundary survive database reopen; message contents remain stored.",
  );
  passed = true;
} catch (failure) {
  error = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  const out = resolve(".openbot-build/agent-thread-unread-service-e2e");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      {
        passed,
        checks,
        error,
        environment:
          "Real agent/task services, SQLite and publication events; temporary state; no provider or browser calls.",
      },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ passed, checks: checks.length, error })}\n`);
}
