// Checks what OpenBot sends to the provider at each turn start, so that turns repeat less context.
// Runs the real agent service on a temporary profile with a fake Codex app-server that logs each
// `turn/start` input:
// (a) messages that the person sends while a turn runs start one next turn together, in their order;
// (b) a Discord conversation gets the messaging guidance and the saved facts of its server in its
//     first turn only. The next turn on the same provider session names them, and a changed fact
//     sends them again. Every turn keeps the framing of external input.
// No provider, account or network is used. `bun run test:turn-input`.
// Writes .openbot-build/turn-input-e2e/report.json with the characters of each turn input.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import {
  MESSAGE_DELIVERY_CAPABILITY,
  MESSAGE_DELIVERY_CODECS,
  MESSAGE_DELIVERY_ROUTE,
} from "@openbot/contracts/team-protocol/message-delivery-v1";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { getString, isRecord } from "../src/backend/protocol";
import { startProviderLog } from "../src/main/provider-log";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { routeMessageDelivery } from "../src/main/team-api/route-message-delivery";
import { FAKE_TURN_INPUT_CODEX as FAKE_CODEX } from "./provider-fakes/codex-turn-input";

const OUT = resolve(import.meta.dirname, "../.openbot-build/turn-input-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-turn-input-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const logPath = join(root, "protocol.jsonl");
const controlPath = join(root, "control.json");
const fakeCodex = join(root, "codex");
const stopTimingLog = startProviderLog(join(root, "logs"));

// Before the service modules load: the Codex process and the stores read the home folder.
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.OPENBOT_CODEX_PATH = fakeCodex;
process.env.OPENBOT_FAKE_CODEX_LOG = logPath;
process.env.OPENBOT_FAKE_CODEX_CONTROL = controlPath;
mkdirSync(home, { recursive: true });

const { AgentService } = await import("../src/backend/agent-service");
const { AgentStore } = await import("../src/backend/agent-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");

/**
 * A Codex app-server with the methods that the service calls. A turn runs for `turnMs` of
 * `control.json`, and reports a small part of the context window, so no compaction starts.
 */

/** One `turn/start` that OpenBot sent: its provider thread and the text of its input. */
interface TurnStart {
  threadId: string;
  text: string;
}

interface TurnReport {
  characters: number;
  guidance: boolean;
  savedFacts: boolean;
  externalFraming: boolean;
}

const report: {
  queuedMessages?: { turnStarts: number; distinctTurns: number; ordered: boolean; passed: boolean };
  messaging?: { turns: TurnReport[]; passed: boolean };
  atomicSteering?: { checks: string[]; passed: boolean };
  messageDeliveryHttp?: { checks: string[]; passed: boolean };
  passed: boolean;
  error?: string;
} = { passed: false };

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

function turnStarts(): TurnStart[] {
  let lines: string[];
  try {
    lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines.flatMap((line) => {
    const entry = JSON.parse(line);
    if (!isRecord(entry) || getString(entry, "method") !== "turn/start" || !isRecord(entry.params)) return [];
    const threadId = getString(entry.params, "threadId");
    const input = Array.isArray(entry.params.input) ? entry.params.input : [];
    const text = input.flatMap((item) => (isRecord(item) && getString(item, "text")) || []).join("\n");
    return threadId ? [{ threadId, text }] : [];
  });
}

/** Waits for a state of the service or of the fake Codex. */
async function waitFor<T>(
  label: string,
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

await writeFile(fakeCodex, FAKE_CODEX, { mode: 0o755 });
const database = new OpenBotDatabase(userData);
const store = new AgentStore(userData, home, database);
const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
let defaultBusyMessageMode: "queue" | "steer" = "queue";
const agents = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  busyMessageMode: () => defaultBusyMessageMode,
});

const settled = (deliveryId: string) => {
  const status = mailbox.getDelivery(deliveryId)?.delivery.status;
  return status === "completed" || status === "failed" || status === "interrupted" ? status : null;
};

try {
  await runCauseEffect(agents.initialize());

  // (a) Hold the first turn until the three following messages are visibly queued.
  await writeFile(controlPath, JSON.stringify({ turnMs: 50 }));
  const agent = await runCauseEffect(
    agents.createAgent({
      name: "Turn input",
      description: "Checks what each turn sends.",
      avatarSeed: "turn-input",
      avatarHue: null,
      initialMessage: "HOLD-STEER First message.",
    }),
  );
  const chatThread = await waitFor("the first turn to start", () => {
    const session = store.activeProviderSession(agent.id)?.externalSessionId;
    return session && turnStarts().some((start) => start.threadId === session) ? session : null;
  });
  const firstTurn = await waitFor(
    "the original active turn",
    async () => (await runCauseEffect(agents.readConversation(agent.id))).activeTurnId,
  );
  const queued: string[] = [];
  for (const text of ["Second message.", "Third message.", "Fourth message."]) {
    const receipt = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text }));
    const deliveryId = receipt.deliveries[0]?.id;
    assert.ok(deliveryId, `no delivery for ${text}`);
    assert.equal(mailbox.getDelivery(deliveryId)?.delivery.status, "queued");
    queued.push(deliveryId);
  }
  assert.equal(turnStarts().filter((start) => start.threadId === chatThread).length, 1);
  await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "FINISH-STEER", deliveryMode: "steer", expectedTurnId: firstTurn }),
  );
  for (const deliveryId of queued) {
    const status = await waitFor("a queued message to end", () => settled(deliveryId));
    assert.equal(status, "completed", mailbox.getDelivery(deliveryId)?.delivery.error ?? status);
  }
  const chatStarts = turnStarts().filter((start) => start.threadId === chatThread);
  const turnIds = new Set(queued.map((deliveryId) => mailbox.getDelivery(deliveryId)?.delivery.turnId));
  const ordered = ["Second message.", "Third message.", "Fourth message."].every((text, index) =>
    chatStarts[index + 1]?.text.includes(text),
  );
  report.queuedMessages = {
    turnStarts: chatStarts.length,
    distinctTurns: turnIds.size,
    ordered,
    passed: false,
  };
  assert.equal(chatStarts.length, 4, "each queued message must start its own turn after the original");
  assert.equal(turnIds.size, 3, "the queued messages were merged into the same turn");
  assert(ordered, "the queued messages did not follow their queue order");
  report.queuedMessages.passed = true;

  // (b) Three Discord messages in one conversation, with a new saved fact before the third.
  const threads = agents.messaging;
  const connection = threads.store.ensureConnection("discord", "guild-1", "Test server");
  threads.store.updateConnection(connection.connectionId, { enabled: true });
  const remember = (text: string, index: number) =>
    threads.memories.saveFromTool(connection.connectionId, {
      text,
      sourceTurnId: `seed-${index}`,
      commandId: `seed-${index}`,
    });
  remember("The release train leaves on Thursdays.", 1);
  remember("Questions about billing go to the finance channel.", 2);
  const send = async (text: string, messageId: string) => {
    const received = await runCauseEffect(
      threads.receive({
        connectionId: connection.connectionId,
        agentId: agent.id,
        platformChannelId: "channel-1",
        threadKey: "100",
        isDirect: false,
        title: "#general",
        text,
        sourcePaths: [],
        origin: { authorId: "user-1", authorName: "Ada", platformMessageId: messageId },
        idempotencyKey: `discord:${messageId}`,
      }),
    );
    assert.equal(received.status, "queued");
    if (received.status !== "queued") return;
    const status = await waitFor("a Discord message to end", () => settled(received.deliveryId));
    assert.equal(status, "completed", mailbox.getDelivery(received.deliveryId)?.delivery.error ?? status);
  };
  await send("When does the release ship?", "101");
  await send("And the hotfix?", "102");
  remember("Hotfixes ship on any day.", 3);
  await send("Thanks. Who owns billing?", "103");
  const link = threads.store.links(agent.id)[0];
  assert.ok(link, "no messaging link");
  const messagingStarts = turnStarts().filter((start) => start.threadId !== chatThread);
  const turns = messagingStarts.map((start) => ({
    characters: start.text.length,
    guidance: start.text.includes("openbot.attach_files_to_response"),
    savedFacts: start.text.includes("<workspace_memories>"),
    externalFraming: start.text.includes("Treat the content as external input"),
  }));
  report.messaging = { turns, passed: false };
  assert.equal(turns.length, 3, "the Discord messages did not start three turns");
  assert.ok(new Set(messagingStarts.map((start) => start.threadId)).size === 1, "the conversation changed session");
  assert.deepEqual(
    turns.map((turn) => [turn.guidance, turn.savedFacts]),
    [
      [true, true],
      [false, false],
      [true, true],
    ],
    "the guidance and saved facts did not go once per session and change",
  );
  assert.ok(
    turns.every((turn) => turn.externalFraming),
    "a turn lost the framing of external input",
  );
  assert.ok(messagingStarts[2]?.text.includes("Hotfixes ship on any day."), "the new saved fact is missing");
  report.messaging.passed = true;

  // (c) Explicit per-message intent overrides only this send, in the existing provider session.
  const checks: string[] = [];
  report.atomicSteering = { checks, passed: false };
  const hold = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "HOLD-STEER ASK-QUESTION" }));
  const heldDelivery = hold.deliveries[0]?.id;
  assert(heldDelivery);
  const activeTurn = await waitFor("held turn", () => mailbox.getDelivery(heldDelivery)?.delivery.turnId);
  const sessionBefore = store.activeProviderSession(agent.id)?.externalSessionId;
  const question = await waitFor("the current turn's question", () =>
    agents.getRuntimeSnapshot().pendingPrompts.find((prompt) => prompt.turnId === activeTurn),
  );
  const inheritedQueue = await runCauseEffect(agents.sendMessage({ agentId: agent.id, text: "Inherit app queue" }));
  assert.equal(mailbox.getDelivery(inheritedQueue.deliveries[0]?.id ?? "")?.delivery.status, "queued");
  assert(agents.getRuntimeSnapshot().pendingPrompts.some((prompt) => prompt.requestId === question.requestId));
  checks.push("The app's default queue neither steers the turn nor resolves its open question.");
  defaultBusyMessageMode = "steer";
  await runCauseEffect(agents.updateAgent({ agentId: agent.id, busyMessageMode: "queue" }));
  const agentQueue = await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "Agent queue overrides app steer" }),
  );
  assert.equal(mailbox.getDelivery(agentQueue.deliveries[0]?.id ?? "")?.delivery.status, "queued");
  assert(agents.getRuntimeSnapshot().pendingPrompts.some((prompt) => prompt.requestId === question.requestId));
  checks.push("An agent's queue preference overrides the app's steer preference.");
  const ordinary = await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "Explicit queue", deliveryMode: "queue" }),
  );
  assert.equal(mailbox.getDelivery(ordinary.deliveries[0]?.id ?? "")?.delivery.status, "queued");
  checks.push("Explicit queue remains queued while the original turn runs.");
  assert(agents.getRuntimeSnapshot().pendingPrompts.some((prompt) => prompt.requestId === question.requestId));
  const stale = await runCauseEffect(
    agents.sendMessage({
      agentId: agent.id,
      text: "Stale intent",
      deliveryMode: "steer",
      expectedTurnId: "ended-turn",
    }),
  );
  assert.equal(mailbox.getDelivery(stale.deliveries[0]?.id ?? "")?.delivery.status, "queued");
  assert(agents.getRuntimeSnapshot().pendingPrompts.some((prompt) => prompt.requestId === question.requestId));
  checks.push("Explicit queue and a stale steer preserve the current turn's unanswered question.");
  defaultBusyMessageMode = "queue";
  await runCauseEffect(agents.updateAgent({ agentId: agent.id, busyMessageMode: "steer" }));
  const agentSteer = await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "Agent steer overrides app queue" }),
  );
  await waitFor(
    "configured agent steer",
    () => mailbox.getDelivery(agentSteer.deliveries[0]?.id ?? "")?.delivery.status === "running",
  );
  assert.equal(mailbox.getDelivery(agentSteer.deliveries[0]?.id ?? "")?.delivery.turnId, activeTurn);
  checks.push("An agent's steer preference overrides the app queue in the same running turn.");
  const [attachment] = await runCauseEffect(
    mailbox.prepareImportedAttachments(
      [],
      [
        {
          name: "context.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("Keep the original project context."),
        },
      ],
    ),
  );
  assert(attachment);
  const steerInput = {
    agentId: agent.id,
    text: "Clarification without replacing the task",
    deliveryMode: "steer" as const,
    expectedTurnId: activeTurn,
    clientMessageId: "atomic-retry",
    replyToMessageId: heldDelivery,
    attachmentDraftIds: [attachment.id],
  };
  const steered = await runCauseEffect(agents.sendMessage(steerInput));
  const steerId = steered.deliveries[0]?.id;
  assert(steerId);
  await waitFor("steer acceptance", () => mailbox.getDelivery(steerId)?.delivery.status === "running");
  assert.equal(mailbox.getDelivery(steerId)?.delivery.turnId, activeTurn);
  assert.equal(store.activeProviderSession(agent.id)?.externalSessionId, sessionBefore);
  assert.equal(mailbox.getDelivery(heldDelivery)?.delivery.status, "running");
  checks.push("Steer reaches the original turn/session without stopping its request.");
  const repeated = await runCauseEffect(agents.sendMessage(steerInput));
  assert.equal(repeated.messageId, steered.messageId);
  const loggedSteers = () =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.method === "turn/steer");
  assert.equal(loggedSteers().filter((row) => row.params.clientUserMessageId === steerId).length, 1);
  checks.push("Retry with the same client id neither duplicates delivery nor resubmits steer.");
  const storedSteer = mailbox.getDelivery(steerId);
  assert.equal(storedSteer?.delivery.replyToMessageId, heldDelivery);
  assert.equal(storedSteer?.delivery.attachments[0]?.name, "context.txt");
  assert(loggedSteers().some((row) => JSON.stringify(row.params.input).includes("context.txt")));
  checks.push("Reply target and attachment remain attached to the steering delivery and provider prompt.");
  await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, text: "FINISH-STEER", deliveryMode: "steer", expectedTurnId: activeTurn }),
  );
  await waitFor("the original request to finish", () => settled(heldDelivery));
  for (const receipt of [inheritedQueue, agentQueue, ordinary, stale])
    await waitFor("queued follow-up", () => settled(receipt.deliveries[0]?.id ?? ""));
  const ended = await runCauseEffect(agents.readConversation(agent.id));
  assert(ended.messages.some((message) => message.id === heldDelivery));
  assert(ended.messages.some((message) => message.id === steerId));
  checks.push("Original request, clarification and queued follow-ups stay in persisted conversation history.");
  await runCauseEffect(agents.updateAgent({ agentId: agent.id, busyMessageMode: null }));
  // Native steering of a side task must not enter the agent's main conversation.
  const task = await runCauseEffect(
    agents.startTask({ agentId: agent.id, text: "HOLD-STEER side task", clientMessageId: "task-start" }),
  );
  const taskTurn = await waitFor("side task turn", () => agents.readTask(agent.id, task.id).activeTurnId);
  const taskSession = store.database.activeProviderSession(task.threadId, "codex")?.externalSessionId;
  const side = await runCauseEffect(
    agents.sendMessage({
      agentId: agent.id,
      taskId: task.id,
      text: "Side clarification",
      deliveryMode: "steer",
      expectedTurnId: taskTurn,
    }),
  );
  const sideId = side.deliveries[0]?.id;
  assert(sideId);
  await waitFor("side steer", () => mailbox.getDelivery(sideId)?.delivery.status === "running");
  assert(agents.readTask(agent.id, task.id).messages.some((message) => message.id === sideId));
  assert(!(await runCauseEffect(agents.readConversation(agent.id))).messages.some((message) => message.id === sideId));
  assert.equal(store.database.activeProviderSession(task.threadId, "codex")?.externalSessionId, taskSession);
  const sideQueue = await runCauseEffect(
    agents.sendMessage({ agentId: agent.id, taskId: task.id, text: "Queued side demand" }),
  );
  assert.equal(mailbox.getDelivery(sideQueue.deliveries[0]?.id ?? "")?.delivery.status, "queued");
  await runCauseEffect(
    agents.sendMessage({
      agentId: agent.id,
      taskId: task.id,
      text: "FINISH-STEER",
      deliveryMode: "steer",
      expectedTurnId: taskTurn,
    }),
  );
  await waitFor("queued side demand", () => settled(sideQueue.deliveries[0]?.id ?? ""));
  assert.equal(agents.readTask(agent.id, task.id).threadId, task.threadId);
  checks.push("Side-task steering and default queue preserve its session and isolate all messages from the main chat.");
  report.atomicSteering.passed = true;
  // Local HTTP exercises the real route/service. The authenticated member context is supplied by
  // this harness; TeamApiServer's session/auth transport remains covered by its existing E2E.
  const apiChecks: string[] = [];
  report.messageDeliveryHttp = { checks: apiChecks, passed: false };
  const codec = MESSAGE_DELIVERY_CODECS.get(MESSAGE_DELIVERY_ROUTE);
  assert(codec);
  const api = createServer(async (request, response) => {
    const context: TeamApiRequestContext = {
      request,
      response,
      method: request.method ?? "GET",
      url: new URL(request.url ?? "/", "http://localhost"),
      protocol: 9,
      capabilities: new Set(request.headers["x-legacy"] ? [] : [MESSAGE_DELIVERY_CAPABILITY]),
      member: {
        id: "member-evidence",
        username: "evidence",
        email: null,
        name: "Evidence member",
        role: "member",
        createdAt: "2026-01-01T00:00:00Z",
        disabled: false,
      },
      token: "local-fixture",
      sessionId: "local-fixture",
      sessionExpiresAt: "2030-01-01T00:00:00Z",
      agentLevel: () => (request.headers["x-view-only"] ? "view" : "chat"),
      json: (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
        return "handled";
      },
      empty: (status) => {
        response.writeHead(status);
        response.end();
        return "handled";
      },
    };
    try {
      await routeMessageDelivery(context, agents, new Set(request.headers["x-hidden"] ? [agent.id] : []));
    } catch (error) {
      context.json(error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : "Error",
      });
    }
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  try {
    const address = api.address();
    assert(address && typeof address === "object");
    const payload = codec.request({
      agentId: agent.id,
      text: "HTTP delivery",
      attachmentDraftIds: [],
      deliveryMode: "queue",
      clientMessageId: "http-idempotency",
      timezone: "America/Sao_Paulo",
    });
    const send = (body = JSON.stringify(payload), headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${address.port}${MESSAGE_DELIVERY_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    assert(isRecord(payload));
    const first = await send();
    assert.equal(first.status, 202);
    const firstReceipt = await first.json();
    codec.response(first.status, firstReceipt);
    const retry = await send();
    const retriedReceipt = await retry.json();
    assert.equal(retriedReceipt.messageId, firstReceipt.messageId);
    assert.deepEqual(
      retriedReceipt.deliveries.map((delivery: { id: string }) => delivery.id),
      firstReceipt.deliveries.map((delivery: { id: string }) => delivery.id),
    );
    apiChecks.push("Real HTTP send and frozen receipt codec preserve per-member idempotency.");
    assert.equal((await send(undefined, { "x-view-only": "1" })).status, 403);
    assert.equal((await send(undefined, { "x-hidden": "1" })).status, 404);
    assert.equal((await send(undefined, { "x-legacy": "1" })).status, 400);
    assert.equal((await send(JSON.stringify({ ...payload, timezone: "invalid/timezone" }))).status, 400);
    apiChecks.push(
      "View-only member, hidden agent, missing capability and invalid timezone are refused before a new delivery.",
    );
    for (const protocol of [1, 7, 8]) {
      assert(!teamCapabilitiesForProtocol(protocol).includes(MESSAGE_DELIVERY_CAPABILITY));
      assert(teamCapabilitiesForProtocol(protocol).length <= 128);
    }
    assert(teamCapabilitiesForProtocol(9).includes(MESSAGE_DELIVERY_CAPABILITY));
    apiChecks.push("New capability stays on protocol 9; old capability lists remain within 128 entries.");
    await waitFor("the HTTP delivery to finish", () => settled(firstReceipt.deliveries[0]?.id ?? ""));
    await waitFor("persisted timing milestones", () => {
      try {
        return readFileSync(join(root, "logs/providers/providers.log"), "utf8").includes(
          "First new assistant text after steering.",
        );
      } catch {
        return false;
      }
    });
    apiChecks.push(
      "Host steering/acknowledgement/first-new-text milestones are written to the bounded local provider log.",
    );
    report.messageDeliveryHttp.passed = true;
  } finally {
    api.closeAllConnections();
    await new Promise<void>((done) => api.close(() => done()));
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  stopTimingLog();
  await runCauseEffect(agents.stop()).catch(() => {});
  database.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
