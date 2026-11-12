// Real agent/task services, event store and SQLite. Browser and providers are not used by this flow.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationSnapshot, TransferAgentTaskInput } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { discoverTools } from "../src/backend/agent/tool-catalog";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { AgentTasks, TRANSFER_TASK_TOOL } from "../src/backend/agent-tasks/agent-tasks";
import { AgentThreadStore } from "../src/backend/agent-threads/agent-thread-store";
import { ConversationReadStore } from "../src/backend/conversation-read-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import type { DynamicToolCallParams } from "../src/backend/protocol";

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
function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, wait, entered: () => entered(), release: () => release() };
}

// Real mailbox and filesystem operations remain in use; only their asynchronous boundary is held.
class ObservedMailbox extends MailboxStore {
  afterFileCopy: (() => void) | undefined;
  duringTransfer: (() => void) | undefined;
  deleteGate: ReturnType<typeof barrier> | undefined;
  messageDeleteGate: ReturnType<typeof barrier> | undefined;
  constructor(...args: ConstructorParameters<typeof MailboxStore>) {
    super(...args);
    const deleteTask = this.deleteTaskMessages;
    const deleteShown = this.deleteShownMessage.bind(this);
    this.deleteTaskMessages = (agentId, taskId) =>
      Effect.gen({ self: this }, function* () {
        const gate = this.deleteGate;
        if (gate) {
          gate.entered();
          yield* Effect.promise(() => gate.wait);
        }
        return yield* deleteTask(agentId, taskId);
      });
    this.deleteShownMessage = (agentId, messageId) =>
      Effect.gen({ self: this }, function* () {
        const gate = this.messageDeleteGate;
        if (gate) {
          gate.entered();
          yield* Effect.promise(() => gate.wait);
        }
        return yield* deleteShown(agentId, messageId);
      });
  }
  override prepareDelivery(agentIds: string[]): () => void {
    const validate = super.prepareDelivery(agentIds);
    let count = 0;
    return () => {
      validate();
      count++;
      if (agentIds.length === 1 && count === 2) this.afterFileCopy?.();
      if (agentIds.length === 2) this.duringTransfer?.();
    };
  }
}

const root = await mkdtemp(join(tmpdir(), "openbot-task-transfer-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const store = new AgentStore(state, join(root, "home"), database);
const mailbox = new ObservedMailbox(state, store.sharedRoot, database);
const service = new AgentService({ store, mailbox, browser });
const threads = new AgentThreadStore(database);
const toolConversation = new ConversationRuntime(
  store,
  () => {},
  () => store.list(),
);
const toolTasks = new AgentTasks({
  store: threads,
  mailbox,
  conversation: toolConversation,
  hooks: {
    transfer: (input) => service.transferTask(input, { requireVisibleTarget: true }),
    emit: () => {},
    agent: (id) => store.list().find((agent) => agent.id === id),
    hold: () => null,
    queued: () => {},
    turnActive: (agentId, threadId) => database.readActiveTurnId(agentId, threadId) !== null,
    archived: () => Effect.void,
  },
});
const toolParams = (args: unknown): DynamicToolCallParams => ({
  namespace: "openbot",
  tool: TRANSFER_TASK_TOOL,
  threadId: "tool-main",
  turnId: "tool-turn",
  callId: crypto.randomUUID(),
  arguments: args,
});
const invoke = (agentId: string, params: DynamicToolCallParams, inExecutionThread = false) =>
  Effect.runPromise(toolTasks.handleTool(params, { agentId, inExecutionThread }));
const checks: string[] = [];
let passed = false;
let error = "";
const transfer = (input: TransferAgentTaskInput) => runCauseEffect(service.transferTask(input));
try {
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const createAgent = (name: string) =>
    runCauseEffect(
      store.createAgent({ name, description: "Transfer fixture", avatarSeed: name.toLowerCase(), avatarHue: null }),
    );
  const a = await createAgent("Source");
  const b = await createAgent("Target");
  const c = await createAgent("Third");
  const task = threads.create({ agentId: a.id, origin: "user", title: "Retained conversation", titleSource: "auto" });
  const sourcePath = join(root, "uploaded.txt");
  await writeFile(sourcePath, "Original uploaded bytes\n");
  const receipt = await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "user" },
      taskId: task.taskId,
      recipientAgentIds: [a.id],
      text: "Original brief",
      sourcePaths: [sourcePath],
    }),
  );
  const delivery = receipt.deliveries[0];
  assert(delivery);
  const context = mailbox.getDelivery(delivery.id);
  assert(context);
  const uploaded = context.managedAttachments[0];
  assert(uploaded);
  await runCauseEffect(mailbox.markStarting(delivery.id));
  await runCauseEffect(mailbox.markTerminal(delivery.id, "completed"));
  const generated = await runCauseEffect(
    mailbox.storeGeneratedAttachment({
      bytes: new TextEncoder().encode("Generated bytes\n"),
      name: "generated.txt",
      mimeType: "text/plain",
      ownerAgentId: a.id,
      ownerThreadId: task.threadId,
    }),
  );
  const snapshot: ConversationSnapshot = {
    agentId: a.id,
    threadId: task.threadId,
    activeTurnId: null,
    revision: 0,
    messages: Array.from({ length: 150 }, (_, index) => ({
      id: `kept-${index}`,
      author: "assistant",
      source: "assistant",
      text: `Original answer ${index}`,
      status: "completed",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
      ...(index === 0 ? { attachments: [uploaded] } : index === 149 ? { attachments: [generated] } : {}),
    })),
  };
  database.persistConversation(snapshot, "fixture.created");
  threads.setOutcome(task.taskId, "completed");
  service.markTaskRead({ agentId: a.id, taskId: task.taskId, throughMessageId: "kept-139" }, "reader-a");
  service.markTaskRead({ agentId: a.id, taskId: task.taskId, throughMessageId: "kept-149" }, "reader-b");
  const readerBefore = service.listTaskReads(a.id, "reader-a").find((read) => read.taskId === task.taskId);
  assert.equal(readerBefore?.unreadCount, 10);
  const contentBefore = database.connection
    .prepare("SELECT message_id,message_json FROM projection_thread_messages WHERE thread_id=? ORDER BY ordinal")
    .all(task.threadId);
  const move = { agentId: a.id, targetAgentId: b.id, taskId: task.taskId, requestId: crypto.randomUUID() };
  const firstToolCall = toolParams({ taskId: task.taskId, targetAgentId: b.id });
  const firstToolResult = await invoke(a.id, firstToolCall);
  assert.equal(firstToolResult?.success, true);
  assert.deepEqual(JSON.parse(firstToolResult?.contentItems[0]?.text ?? "null"), {
    status: "transferred",
    taskId: task.taskId,
    targetAgentId: b.id,
  });
  assert.equal(threads.task(task.taskId)?.agentId, b.id);
  assert.equal(threads.task(task.taskId)?.threadId, task.threadId);
  assert.equal(threads.task(task.taskId)?.createdAt, task.createdAt);
  assert.deepEqual(
    database.connection
      .prepare("SELECT message_id,message_json FROM projection_thread_messages WHERE thread_id=? ORDER BY ordinal")
      .all(task.threadId),
    contentBefore,
  );
  assert.equal(service.readTask(b.id, task.taskId).agentId, b.id);
  assert.throws(() => service.readTask(a.id, task.taskId));
  const older = service.readTaskPage({ agentId: b.id, taskId: task.taskId, beforeMessageId: "kept-100", limit: 100 });
  assert(older.conversation.messages.some((message) => message.id === "kept-0"));
  assert.deepEqual(
    service.listTaskReads(b.id, "reader-a").find((read) => read.taskId === task.taskId),
    readerBefore,
  );
  assert.equal(service.listTaskReads(b.id, "reader-b").find((read) => read.taskId === task.taskId)?.unreadCount, 0);
  checks.push(
    "A→B retains the same task/thread, all 150 message identities and bytes, paging, dates and two independent read cursors; old owner is refused.",
  );
  for (const [file, bytes] of [
    [uploaded, "Original uploaded bytes\n"],
    [generated, "Generated bytes\n"],
  ] as const) {
    const resolved = await runCauseEffect(mailbox.resolveAttachment(file.id));
    assert(resolved);
    assert.equal(await readFile(resolved.path, "utf8"), bytes);
  }
  checks.push("Uploaded and generated attachments still resolve to the original bytes after the move.");
  await transfer({ agentId: b.id, targetAgentId: c.id, taskId: task.taskId, requestId: crypto.randomUUID() });
  assert.deepEqual(await invoke(a.id, firstToolCall), firstToolResult);
  assert.equal(threads.task(task.taskId)?.agentId, c.id);
  await transfer({ agentId: c.id, targetAgentId: a.id, taskId: task.taskId, requestId: crypto.randomUUID() });
  assert.equal(service.listTaskReads(a.id, "reader-a").find((read) => read.taskId === task.taskId)?.unreadCount, 10);
  checks.push(
    "A→B→C, replaying A→B requestId and moving back preserve ownership intent and unread counts without duplicate copies.",
  );
  database.connection.exec(`CREATE TEMP TRIGGER refuse_transfer BEFORE UPDATE OF agent_id ON projection_agent_threads
    BEGIN SELECT RAISE(ABORT, 'controlled transfer failure'); END`);
  const rollbackMove = { ...move, requestId: crypto.randomUUID() };
  await assert.rejects(transfer(rollbackMove));
  assert.equal(threads.task(task.taskId)?.agentId, a.id);
  assert.equal(mailbox.getDelivery(delivery.id)?.delivery.recipientAgentId, a.id);
  const uploadedAfterRollback = await runCauseEffect(mailbox.resolveAttachment(uploaded.id));
  assert(uploadedAfterRollback);
  assert.equal(await readFile(uploadedAfterRollback.path, "utf8"), "Original uploaded bytes\n");
  assert.deepEqual(
    database.connection
      .prepare("SELECT message_id,message_json FROM projection_thread_messages WHERE thread_id=? ORDER BY ordinal")
      .all(task.threadId),
    contentBefore,
  );
  database.connection.exec("DROP TRIGGER refuse_transfer");
  await transfer(rollbackMove);
  assert.equal(threads.task(task.taskId)?.agentId, b.id);
  checks.push(
    "A forced storage failure rolls back task, mailbox and receipt; live state keeps the source, and the same request succeeds after rollback.",
  );
  const branchSource = threads.create({ agentId: a.id, origin: "user", title: "Branch source", titleSource: "auto" });
  database.persistConversation(
    {
      agentId: a.id,
      threadId: branchSource.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "branch-answer",
          author: "assistant",
          source: "assistant",
          status: "completed",
          text: "Retained branch context",
          createdAt: new Date().toISOString(),
        },
      ],
    },
    "fixture.created",
  );
  const branch = await Effect.runPromise(
    service.branchTask(
      { agentId: a.id, taskId: branchSource.taskId, messageId: "branch-answer", requestId: crypto.randomUUID() },
      "reader-a",
    ),
  );
  assert(branch.branch);
  const internalBranch = threads.task(branch.id)?.branch;
  await transfer({ agentId: a.id, targetAgentId: b.id, taskId: branch.id, requestId: crypto.randomUUID() });
  assert.equal(service.listTasks(b.id).tasks.find((task) => task.id === branch.id)?.branch, null);
  assert.deepEqual(threads.task(branch.id)?.branch, internalBranch);
  await transfer({ agentId: b.id, targetAgentId: a.id, taskId: branch.id, requestId: crypto.randomUUID() });
  assert.deepEqual(service.listTasks(a.id).tasks.find((task) => task.id === branch.id)?.branch, branch.branch);
  checks.push(
    "A transferred branch retains its internal source and history; its same-agent link hides across agents and returns on transfer back.",
  );
  const described = discoverTools({ ...toolParams({ name: "openbot.transfer_task" }), tool: "tool_describe" }, "codex");
  assert(described.tools.some((tool) => tool.name === "openbot.transfer_task" && "inputSchema" in tool));
  assert(JSON.stringify(described).includes("list_agents"));
  assert(JSON.stringify(described).includes("history_search"));
  checks.push("The real deferred catalog describes openbot.transfer_task, its input schema and discovery guidance.");
  const ownTool = threads.create({ agentId: a.id, origin: "agent", title: "Tool-owned task", titleSource: "agent" });
  for (const args of [
    null,
    {},
    { taskId: "", targetAgentId: b.id },
    { taskId: ownTool.taskId, targetAgentId: "x".repeat(1000) },
    { taskId: ownTool.taskId, targetAgentId: b.id, agentId: c.id },
    { taskId: ownTool.taskId, targetAgentId: b.id, serverId: "remote" },
  ]) {
    assert.equal((await invoke(a.id, toolParams(args)))?.success, false);
    assert.equal(threads.task(ownTool.taskId)?.agentId, a.id);
  }
  assert.equal((await invoke(c.id, toolParams({ taskId: ownTool.taskId, targetAgentId: b.id })))?.success, false);
  assert.equal((await invoke(a.id, toolParams({ taskId: ownTool.taskId, targetAgentId: b.id }), true))?.success, false);
  for (const targetAgentId of [a.id, "missing-target"])
    assert.equal((await invoke(a.id, toolParams({ taskId: ownTool.taskId, targetAgentId })))?.success, false);
  store.setHidden(c.id, new Date().toISOString());
  assert.equal((await invoke(a.id, toolParams({ taskId: ownTool.taskId, targetAgentId: c.id })))?.success, false);
  store.setHidden(c.id, null);
  assert.equal(threads.task(ownTool.taskId)?.agentId, a.id);
  assert.equal((await invoke(a.id, toolParams({ taskId: ownTool.taskId, targetAgentId: b.id })))?.success, true);
  checks.push(
    "The tool moves user-created and agent-created own tasks; it refuses malformed input, caller/server spoofing, foreign ownership, execution-thread callers, self, missing and hidden targets.",
  );
  const hiddenRace = threads.create({ agentId: a.id, origin: "agent", title: "Visibility race", titleSource: "agent" });
  const raceCall = toolParams({ taskId: hiddenRace.taskId, targetAgentId: c.id });
  let validations = 0;
  mailbox.duringTransfer = () => {
    if (++validations === 2) store.setHidden(c.id, new Date().toISOString());
  };
  assert.equal((await invoke(a.id, raceCall))?.success, false);
  mailbox.duringTransfer = undefined;
  assert.equal(threads.task(hiddenRace.taskId)?.agentId, a.id);
  store.setHidden(c.id, null);
  const raceSuccess = await invoke(a.id, raceCall);
  assert.equal(raceSuccess?.success, true);
  store.setHidden(c.id, new Date().toISOString());
  assert.deepEqual(await invoke(a.id, raceCall), raceSuccess);
  store.setHidden(c.id, null);
  checks.push(
    "The final service check refuses a target hidden between validations; a completed tool call still replays its receipt if the target is hidden later.",
  );
  const failedTool = threads.create({ agentId: a.id, origin: "agent", title: "Failure retry", titleSource: "agent" });
  const retryCall = toolParams({ taskId: failedTool.taskId, targetAgentId: b.id });
  database.connection.exec(
    `CREATE TEMP TRIGGER refuse_tool_transfer BEFORE UPDATE OF agent_id ON projection_agent_threads BEGIN SELECT RAISE(ABORT, '/private/secret-storage-path'); END`,
  );
  const failedResult = await invoke(a.id, retryCall);
  assert.equal(failedResult?.success, false);
  assert.equal(
    JSON.parse(failedResult?.contentItems[0]?.text ?? "null").error,
    sourceText("error.backend.taskTransferFailed"),
  );
  assert(!JSON.stringify(failedResult).includes("secret-storage"));
  assert.equal(threads.task(failedTool.taskId)?.agentId, a.id);
  database.connection.exec("DROP TRIGGER refuse_tool_transfer");
  assert.equal((await invoke(a.id, retryCall))?.success, true);
  checks.push(
    "Tool storage failures return a localized safe error without private paths; rollback leaves ownership intact and the same call retries successfully.",
  );
  const pending = threads.create({ agentId: a.id, origin: "user", title: "Pending", titleSource: "auto" });
  await runCauseEffect(
    mailbox.enqueue({
      sender: { kind: "user" },
      taskId: pending.taskId,
      recipientAgentIds: [a.id],
      text: "Pending work",
    }),
  );
  await assert.rejects(
    transfer({ agentId: a.id, targetAgentId: b.id, taskId: pending.taskId, requestId: crypto.randomUUID() }),
  );
  assert.equal(threads.task(pending.taskId)?.agentId, a.id);
  const pendingResult = await invoke(a.id, toolParams({ taskId: pending.taskId, targetAgentId: b.id }));
  assert.equal(pendingResult?.success, false);
  assert.equal(
    JSON.parse(pendingResult?.contentItems[0]?.text ?? "null").error,
    sourceText("error.backend.threadTransferBusy"),
  );
  const routine = threads.create({
    agentId: a.id,
    origin: "agent",
    title: "Routine",
    titleSource: "agent",
    routineId: "fixture-routine",
  });
  await assert.rejects(
    transfer({ agentId: a.id, targetAgentId: b.id, taskId: routine.taskId, requestId: crypto.randomUUID() }),
  );
  await assert.rejects(
    transfer({ agentId: b.id, targetAgentId: "missing", taskId: task.taskId, requestId: crypto.randomUUID() }),
  );
  const routineResult = await invoke(a.id, toolParams({ taskId: routine.taskId, targetAgentId: b.id }));
  assert.equal(routineResult?.success, false);
  assert.equal(
    JSON.parse(routineResult?.contentItems[0]?.text ?? "null").error,
    sourceText("error.backend.threadTransferRoutine"),
  );
  const unblock = mailbox.blockAgentDeliveries(c.id);
  await assert.rejects(
    transfer({ agentId: b.id, targetAgentId: c.id, taskId: task.taskId, requestId: crypto.randomUUID() }),
  );
  unblock();
  checks.push(
    "Pending work, routine-linked tasks, unavailable targets and an agent being removed refuse without moving the task.",
  );
  // A legacy public ID remains stable; it is not replaced with the thread ID.
  const legacy = threads.create({ agentId: b.id, origin: "user", title: "Legacy", titleSource: "auto" });
  database.connection
    .prepare("UPDATE projection_agent_threads SET legacy_task_id=? WHERE thread_id=?")
    .run("agent-task-legacy-fixture", legacy.threadId);
  await transfer({
    agentId: b.id,
    targetAgentId: c.id,
    taskId: "agent-task-legacy-fixture",
    requestId: crypto.randomUUID(),
  });
  assert.equal(threads.task("agent-task-legacy-fixture")?.threadId, legacy.threadId);
  checks.push("Released legacy task IDs retain their meaning after transfer.");
  const copiedRace = threads.create({ agentId: a.id, origin: "user", title: "Send race", titleSource: "auto" });
  mailbox.afterFileCopy = () => {
    mailbox.afterFileCopy = undefined;
    // Interleave a real successful transfer exactly after real file I/O and before enqueue commits.
    Effect.runSync(
      service.transferTask({
        agentId: a.id,
        targetAgentId: b.id,
        taskId: copiedRace.taskId,
        requestId: crypto.randomUUID(),
      }),
    );
  };
  await assert.rejects(
    runCauseEffect(
      mailbox.enqueue({
        sender: { kind: "user" },
        taskId: copiedRace.taskId,
        recipientAgentIds: [a.id],
        text: "Stale sender",
        sourcePaths: [sourcePath],
      }),
    ),
  );
  assert.equal(threads.task(copiedRace.taskId)?.agentId, b.id);
  assert.equal(mailbox.taskBusy(a.id, copiedRace.taskId), false);
  assert.equal(mailbox.taskBusy(b.id, copiedRace.taskId), false);
  checks.push(
    "An enqueue interleaved after actual attachment copying refuses stale ownership, removes staged files and leaves no old-agent delivery.",
  );
  const deleting = threads.create({ agentId: a.id, origin: "user", title: "Delete race", titleSource: "auto" });
  const deleteGate = barrier();
  mailbox.deleteGate = deleteGate;
  const deleteWork = runCauseEffect(service.deleteTask({ agentId: a.id, taskId: deleting.taskId }));
  await deleteGate.ready;
  await assert.rejects(
    transfer({ agentId: a.id, targetAgentId: b.id, taskId: deleting.taskId, requestId: crypto.randomUUID() }),
  );
  assert.equal(threads.task(deleting.taskId)?.agentId, a.id);
  deleteGate.release();
  await deleteWork;
  mailbox.deleteGate = undefined;
  assert.equal(threads.task(deleting.taskId), null);
  const heldTransfer = threads.create({ agentId: a.id, origin: "user", title: "Transfer wins", titleSource: "auto" });
  mailbox.duringTransfer = () => {
    mailbox.duringTransfer = undefined;
    assert.throws(() => Effect.runSync(service.deleteTask({ agentId: a.id, taskId: heldTransfer.taskId })));
    assert.equal(threads.task(heldTransfer.taskId)?.closedAt, null);
  };
  await transfer({ agentId: a.id, targetAgentId: b.id, taskId: heldTransfer.taskId, requestId: crypto.randomUUID() });
  assert.equal(threads.task(heldTransfer.taskId)?.agentId, b.id);
  assert.equal(threads.task(heldTransfer.taskId)?.closedAt, null);
  checks.push(
    "Delete-first refuses transfer; transfer-first refuses deletion before archiving. Competing operations never delete the destination task.",
  );
  const deletingMessage = threads.create({
    agentId: a.id,
    origin: "user",
    title: "Message delete race",
    titleSource: "auto",
  });
  database.persistConversation(
    {
      agentId: a.id,
      threadId: deletingMessage.threadId,
      activeTurnId: null,
      revision: 0,
      messages: [
        {
          id: "delete-race-answer",
          author: "assistant",
          source: "assistant",
          status: "completed",
          text: "Own answer",
          createdAt: new Date().toISOString(),
        },
      ],
    },
    "fixture.created",
  );
  const messageGate = barrier();
  mailbox.messageDeleteGate = messageGate;
  const messageWork = Effect.runPromise(
    service.deleteConversationMessage(
      { agentId: a.id, taskId: deletingMessage.taskId, messageId: "delete-race-answer" },
      { memberId: "reader-a", deleteAny: true },
    ),
  );
  await messageGate.ready;
  await assert.rejects(
    transfer({ agentId: a.id, targetAgentId: b.id, taskId: deletingMessage.taskId, requestId: crypto.randomUUID() }),
  );
  messageGate.release();
  await messageWork;
  mailbox.messageDeleteGate = undefined;
  await transfer({
    agentId: a.id,
    targetAgentId: b.id,
    taskId: deletingMessage.taskId,
    requestId: crypto.randomUUID(),
  });
  assert.equal(service.readTask(b.id, deletingMessage.taskId).messages.length, 0);
  checks.push(
    "A message deletion holds the task through its mailbox/file await; transfer refuses until it completes, then transfers the consistent history.",
  );
  await runCauseEffect(mailbox.deleteAgentData(a.id));
  for (const file of [uploaded, generated]) assert(await runCauseEffect(mailbox.resolveAttachment(file.id)));
  checks.push(
    "Removing source-agent mailbox data after a completed transfer preserves the destination's uploaded and generated files.",
  );
  database.rebuildThreadProjection(task.threadId);
  assert.equal(database.readConversation(b.id, task.threadId).messages.length, 150);
  assert.equal(threads.task(task.taskId)?.agentId, b.id);
  await runCauseEffect(service.stop());
  database.close();
  const reopened = new OpenBotDatabase(state);
  try {
    await runCauseEffect(reopened.initialize());
    assert.equal(new AgentThreadStore(reopened).task(task.taskId)?.agentId, b.id);
    assert.equal(new ConversationReadStore(reopened).readStateForThread("reader-a", task.threadId).unreadCount, 10);
    assert.deepEqual(
      reopened.connection
        .prepare("SELECT message_id,message_json FROM projection_thread_messages WHERE thread_id=? ORDER BY ordinal")
        .all(task.threadId),
      contentBefore,
    );
  } finally {
    reopened.close();
  }
  checks.push("Replay and SQLite restart retain the new owner, every message and the original unread boundary.");
  passed = true;
} catch (failure) {
  error = failure instanceof Error ? (failure.stack ?? failure.message) : String(failure);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  toolConversation.dispose();
  database.close();
  await mkdir(resolve(".openbot-build/agent-task-transfer-e2e"), { recursive: true });
  await writeFile(
    resolve(".openbot-build/agent-task-transfer-e2e/report.json"),
    JSON.stringify({ passed, checks, error }, null, 2),
  );
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ passed, checks, error }, null, 2)}\n`);
}
