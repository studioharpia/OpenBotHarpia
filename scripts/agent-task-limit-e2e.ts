// Real agent service, queue, scheduler and SQLite with an injected, manually released provider.
// No account, provider network call or installed profile is used.
// Run: bun scripts/agent-task-limit-e2e.ts
// Evidence: .openbot-build/agent-task-limit-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_PROVIDERS,
  type AgentProviderId,
  type AgentSummary,
  DEFAULT_AGENT_DEFAULTS,
  defaultProviderModel,
  isAgentTasksSnapshot,
} from "@openbot/contracts/ipc";
import {
  AGENT_TASK_LIMIT_CAPABILITY,
  AGENT_TASK_LIMIT_CODECS,
  AGENT_TASK_LIMIT_ROUTES,
} from "@openbot/contracts/team-protocol/agent-task-limit-v1";
import {
  AGENT_TASK_LIMIT_V2_CAPABILITY,
  AGENT_TASK_LIMIT_V2_CODECS,
  AGENT_TASK_LIMIT_V2_ROUTES,
  legacyAgentTasksSnapshot,
} from "@openbot/contracts/team-protocol/agent-task-limit-v2";
import {
  AGENT_TASKS_CAPABILITY,
  AGENT_TASKS_CODECS,
  AGENT_TASKS_ROUTES,
  agentTasksEvent,
} from "@openbot/contracts/team-protocol/agent-tasks-v1";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { optionalTeamEvent } from "@openbot/contracts/team-protocol/optional-events";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import { Effect } from "effect";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import type { AgentClient, DiagnosticOrigin } from "../src/backend/agent-client";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import {
  type AppServerNotification,
  type AppServerRequest,
  isRecord,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
} from "../src/backend/protocol";
import { providerSync, requiredString } from "../src/backend/provider-client-effects";
import { NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { createAgentHostSettings } from "../src/main/agent-host-settings";
import { HttpError } from "../src/main/team-api/http-error";
import type { TeamApiRequestContext } from "../src/main/team-api/request-context";
import { requestCapabilities } from "../src/main/team-api/request-helpers";
import { routeAgentTaskLimit } from "../src/main/team-api/route-agent-admin";
import { routeAgentTasks } from "../src/main/team-api/route-agent-tasks";

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

/** Starts real service turns and holds them until the script explicitly finishes a session. */
class ControlledProvider extends EventEmitter<ClientEvents> implements AgentClient {
  running = false;
  readonly active = new Map<string, string>();
  readonly starts: { threadId: string; turnId: string }[] = [];
  readonly #toolReplies = new Map<RequestId, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(readonly provider: AgentProviderId) {
    super();
  }
  start(): void {
    this.running = true;
  }
  stop() {
    return Effect.sync(() => {
      this.running = false;
      this.active.clear();
    });
  }
  request<T>(method: string, params: unknown, decoder: ResponseDecoder<T>) {
    return providerSync(() => {
      switch (method) {
        case "initialize":
        case "config/batchWrite":
          return decoder({});
        case "account/read":
          return decoder({ account: { type: "chatgpt", email: "fixture@example.invalid" } });
        case "account/rateLimits/read":
          return decoder({ rateLimits: null, rateLimitsByLimitId: null });
        case "model/list":
          return decoder({
            data: [
              {
                model: this.provider === "acp" ? "fixture/default" : defaultProviderModel("codex"),
                displayName: "Controlled fixture",
              },
            ],
          });
        case "plugin/list":
          return decoder({ marketplaces: [] });
        case "config/read":
          return decoder({ config: { mcp_servers: {} }, layers: [] });
        case "thread/start":
          return decoder({ thread: { id: randomUUID(), turns: [] } });
        case "thread/resume":
        case "thread/read":
          return decoder({ thread: { id: requiredString(params, "threadId"), turns: [] } });
        case "thread/unsubscribe":
          return decoder({ status: "Unsubscribed" });
        case "thread/turns/list":
        case "thread/items/list":
          return decoder({ data: [], nextCursor: null });
        case "turn/start": {
          const threadId = requiredString(params, "threadId");
          assert.ok(!this.active.has(threadId), "a provider session cannot have two active turns");
          const turnId = randomUUID();
          this.active.set(threadId, turnId);
          this.starts.push({ threadId, turnId });
          this.emit("notification", {
            method: "turn/started",
            params: { threadId, turn: { id: turnId, status: "inProgress" } },
          });
          return decoder({ turn: { id: turnId, status: "inProgress", items: [] } });
        }
        case "turn/interrupt":
          this.finish(requiredString(params, "threadId"), "interrupted");
          return decoder({});
        default:
          throw new Error(`Controlled provider does not implement ${method}.`);
      }
    });
  }
  finish(threadId: string, status = "completed"): void {
    const turnId = this.active.get(threadId);
    assert.ok(turnId, `no active provider turn for ${threadId}`);
    this.active.delete(threadId);
    if (status === "completed")
      this.emit("notification", {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: randomUUID(), text: "Completed controlled turn.", phase: "final_answer" },
        },
      });
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
  }
  /** Provider-side request through the service's real tool router and its trusted caller identity. */
  startTaskTool(threadId: string, title: string): Promise<unknown> {
    const turnId = this.active.get(threadId);
    assert.ok(turnId, "start_task must originate from a real active turn");
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.#toolReplies.delete(callId);
        reject(new Error("Timed out waiting for start_task's tool response."));
      }, 15_000);
      this.#toolReplies.set(callId, {
        resolve: (result) => {
          clearTimeout(deadline);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      });
      this.emit("request", {
        id: callId,
        method: "item/tool/call",
        params: {
          threadId,
          turnId,
          callId,
          namespace: "openbot",
          tool: "tool_call",
          arguments: { name: "openbot.start_task", arguments: { title, brief: `Controlled work for ${title}` } },
        },
      });
    });
  }
  notify(): void {}
  respond(id: RequestId, result: unknown): void {
    const pending = this.#toolReplies.get(id);
    this.#toolReplies.delete(id);
    pending?.resolve(result);
  }
  respondError(id: RequestId, error: RpcError): void {
    const pending = this.#toolReplies.get(id);
    this.#toolReplies.delete(id);
    pending?.reject(new Error(error.message));
  }
}

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
const root = await mkdtemp(join(tmpdir(), "openbot-task-limit-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const store = new AgentStore(state, join(root, "home"), database);
const mailbox = new MailboxStore(state, store.sharedRoot, database);
const clients: ControlledProvider[] = [];
const saved = {
  OPENBOT_CODEX_PATH: process.env.OPENBOT_CODEX_PATH,
  OPENBOT_EXECUTION_CONCURRENCY: process.env.OPENBOT_EXECUTION_CONCURRENCY,
};
const fakeCli = join(root, "codex");
await writeFile(fakeCli, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; else exit 2; fi\n', {
  mode: 0o755,
});
process.env.OPENBOT_CODEX_PATH = fakeCli;
// A host override must never bypass the configured agent limit.
process.env.OPENBOT_EXECUTION_CONCURRENCY = "100";
const service = new AgentService({
  store,
  mailbox,
  browser,
  preferredProvider: "codex",
  memoryReviewInterval: () => 0,
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex" && provider !== "acp"),
  credentials: {
    ...NO_PROVIDER_CREDENTIALS,
    customAgents: () => [
      { id: "fixture", name: "Controlled serial provider", command: fakeCli, args: [], env: [], usagePrompt: null },
    ],
  },
  clientFactory: (provider) => {
    const client = new ControlledProvider(provider);
    clients.push(client);
    return client;
  },
});
const report: {
  passed: boolean;
  checks: string[];
  peaks: Record<string, number>;
  error?: string;
  environment: string;
} = {
  passed: false,
  checks: [],
  peaks: {},
  environment:
    "Real AgentService, mailbox, scheduler and SQLite; injected controlled Codex/ACP clients; no network or installed profile.",
};
async function waitFor<T>(label: string, read: () => T | false | null | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((done) => setTimeout(done, 10));
  }
}
const snapshot = (id: string) => service.listTasks(id);
const running = (id: string) => snapshot(id).tasks.filter((task) => task.activeTurnId !== null);
const create = async (name: string, provider: "codex" | "acp" = "codex") => {
  const agent = await runCauseEffect(
    store.createAgent({
      name,
      description: "Task limit fixture",
      avatarSeed: name.toLowerCase().replaceAll(" ", "-"),
      avatarHue: null,
    }),
  );
  return runCauseEffect(
    service.updateAgent({
      agentId: agent.id,
      provider,
      model: provider === "acp" ? "fixture/default" : defaultProviderModel("codex"),
    }),
  );
};
const startTasks = async (agent: AgentSummary, count: number) => {
  const result = [];
  for (let index = 0; index < count; index += 1)
    result.push(
      await runCauseEffect(
        service.startTask({
          agentId: agent.id,
          text: `${agent.name} task ${index + 1}`,
          clientMessageId: randomUUID(),
        }),
      ),
    );
  return result;
};
interface TaskLimitHttpBody {
  agentId: string;
  taskLimit?: number | null;
}

/** Real HTTP framing, the released request/response codecs, route gates and service settings. */
async function checkHttpRoutes(agentId: string): Promise<void> {
  const admin = {
    agentHost: createAgentHostSettings({
      agents: service,
      busyMessageMode: { get: () => ({ mode: "queue" }) },
      agentDefaults: { get: () => DEFAULT_AGENT_DEFAULTS },
    }),
  };
  const api = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const codec = teamSideRouteCodec(url.pathname);
    const context: TeamApiRequestContext = {
      request,
      response,
      url,
      method: request.method ?? "POST",
      protocol: 9,
      capabilities: requestCapabilities(request),
      member: {
        id: "fixture-member",
        username: "fixture",
        name: "Fixture",
        email: null,
        role: request.headers["x-member"] ? "member" : "admin",
        createdAt: "2026-01-01T00:00:00Z",
        disabled: false,
      },
      token: "local-fixture",
      sessionId: "local-fixture",
      sessionExpiresAt: "2030-01-01T00:00:00Z",
      agentLevel: () => "chat",
      json: (status, value) => {
        const body = codec ? codec.response(url.pathname, status, value) : value;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
        return "handled";
      },
      empty: (status) => {
        response.writeHead(status);
        response.end();
        return "handled";
      },
    };
    try {
      const hidden = new Set(request.headers["x-hidden"] ? [agentId] : []);
      if ((await routeAgentTaskLimit(context, admin, hidden)) === "handled") return;
      if ((await routeAgentTasks(context, service, hidden)) === "handled") return;
      context.json(404, { error: "Unknown fixture route." });
    } catch (failure) {
      context.json(failure instanceof HttpError ? failure.status : 500, {
        error: failure instanceof Error ? failure.message : "Request failed.",
      });
    }
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  try {
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const call = async (path: string, body: TaskLimitHttpBody, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "OpenBot-Protocol-Version": "9",
          "OpenBot-Capabilities": [
            AGENT_TASK_LIMIT_CAPABILITY,
            AGENT_TASK_LIMIT_V2_CAPABILITY,
            AGENT_TASKS_CAPABILITY,
          ].join(","),
          ...headers,
        },
      });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual(await call(AGENT_TASK_LIMIT_ROUTES.settings, { agentId }), {
      status: 200,
      body: { taskLimit: 4 },
    });
    assert.deepEqual(await call(AGENT_TASK_LIMIT_V2_ROUTES.settings, { agentId }), {
      status: 200,
      body: { taskLimit: 10 },
    });
    assert.equal((await call(AGENT_TASK_LIMIT_ROUTES.update, { agentId, taskLimit: 10 })).status, 400);
    assert.deepEqual(await call(AGENT_TASK_LIMIT_V2_ROUTES.update, { agentId, taskLimit: 10 }), {
      status: 200,
      body: { taskLimit: 10 },
    });
    assert.equal((await call(AGENT_TASK_LIMIT_V2_ROUTES.update, { agentId, taskLimit: 11 })).status, 400);
    assert.equal((await call(AGENT_TASK_LIMIT_V2_ROUTES.settings, { agentId }, { "x-member": "1" })).status, 403);
    assert.equal(
      (
        await call(
          AGENT_TASK_LIMIT_V2_ROUTES.settings,
          { agentId },
          { "OpenBot-Capabilities": AGENT_TASK_LIMIT_CAPABILITY },
        )
      ).status,
      400,
    );
    assert.equal((await call(AGENT_TASK_LIMIT_V2_ROUTES.settings, { agentId }, { "x-hidden": "1" })).status, 404);
    const oldList = await call(AGENT_TASKS_ROUTES.list, { agentId }, { "x-member": "1" });
    const newList = await call(AGENT_TASK_LIMIT_V2_ROUTES.list, { agentId }, { "x-member": "1" });
    assert.equal(oldList.status, 200);
    assert.ok(isAgentTasksSnapshot(oldList.body));
    assert.equal(oldList.body.limit, 4);
    assert.equal(newList.status, 200);
    assert.ok(isAgentTasksSnapshot(newList.body));
    assert.equal(newList.body.limit, 10);
    assert.equal(
      (await call(AGENT_TASK_LIMIT_V2_ROUTES.list, { agentId }, { "OpenBot-Capabilities": AGENT_TASKS_CAPABILITY }))
        .status,
      400,
    );
    assert.equal(store.list().find((agent) => agent.id === agentId)?.taskLimit, 10);
    report.checks.push(
      "HTTP routes expose 4 to v1 and 10 to v2, preserve member task reads, refuse non-admin/missing-capability/hidden requests and keep v1 updates capped at 4.",
    );
  } finally {
    api.closeAllConnections();
    await new Promise<void>((done) => api.close(() => done()));
  }
}
async function finishTask(agentId: string, taskId: string): Promise<void> {
  const active = snapshot(agentId).tasks.find((task) => task.id === taskId)?.activeTurnId;
  assert.ok(active);
  const client = clients.find((client) => [...client.active.values()].includes(active));
  assert.ok(client);
  const external = [...client.active.entries()].find(([, turn]) => turn === active)?.[0];
  assert.ok(external);
  client.finish(external);
  await waitFor(
    "the completed task to settle",
    () => snapshot(agentId).tasks.find((task) => task.id === taskId)?.state === "idle",
  );
}
async function closeAll(agentId: string): Promise<void> {
  for (const task of snapshot(agentId).tasks) await runCauseEffect(service.closeTask({ agentId, taskId: task.id }));
  await waitFor("all fixture tasks to close", () => snapshot(agentId).tasks.every((task) => task.state === "closed"));
}
try {
  await runCauseEffect(service.initialize());
  const expanded = await create("Expanded");
  await runCauseEffect(service.updateAgent({ agentId: expanded.id, taskLimit: 10 }));
  const eleven = await startTasks(expanded, 11);
  await waitFor(
    "ten active tasks and the eleventh held",
    () =>
      running(expanded.id).length === 10 &&
      snapshot(expanded.id).tasks.find((task) => task.id === eleven[10]?.id)?.hold === "task-limit",
  );
  assert.equal(new Set(running(expanded.id).map((task) => task.activeTurnId)).size, 10);
  assert.equal(new Set(running(expanded.id).map((task) => task.threadId)).size, 10);
  report.peaks.expanded = running(expanded.id).length;
  report.checks.push(
    "Limit 10 runs ten distinct task turns/sessions; task 11 stays queued with task-limit even with host override 100.",
  );
  await finishTask(expanded.id, eleven[0]?.id ?? "");
  await waitFor(
    "the eleventh task after freeing a slot",
    () => snapshot(expanded.id).tasks.find((task) => task.id === eleven[10]?.id)?.activeTurnId,
  );
  assert.equal(running(expanded.id).length, 10);
  report.checks.push("Completing one real service turn starts the queued eleventh task and keeps ten active.");
  await runCauseEffect(service.updateAgent({ agentId: expanded.id, taskLimit: 2 }));
  assert.equal(running(expanded.id).length, 10);
  const held = await runCauseEffect(
    service.startTask({ agentId: expanded.id, text: "Wait after reduction", clientMessageId: randomUUID() }),
  );
  assert.equal(snapshot(expanded.id).tasks.find((task) => task.id === held.id)?.hold, "task-limit");
  await runCauseEffect(service.updateAgent({ agentId: expanded.id, taskLimit: 10 }));
  assert.equal(running(expanded.id).length, 10);
  report.checks.push(
    "Lowering 10 to 2 preserves active turns; another task waits, and raising the limit does not exceed ten.",
  );
  for (const taskLimit of [0, 11, 1.5])
    await assert.rejects(runCauseEffect(service.updateAgent({ agentId: expanded.id, taskLimit })));
  report.checks.push("Real settings writer refuses zero, eleven and fractional limits.");
  const settingsBefore = store.list().find((agent) => agent.id === expanded.id);
  assert.equal(settingsBefore?.taskLimit, 10);
  const v1 = AGENT_TASK_LIMIT_CODECS.get(AGENT_TASK_LIMIT_ROUTES.update);
  const v2 = AGENT_TASK_LIMIT_V2_CODECS.get(AGENT_TASK_LIMIT_V2_ROUTES.update);
  assert.ok(v1 && v2);
  assert.throws(() => v1.request({ agentId: expanded.id, taskLimit: 10 }));
  assert.deepEqual(v2.request({ agentId: expanded.id, taskLimit: 10 }), { agentId: expanded.id, taskLimit: 10 });
  const real = snapshot(expanded.id);
  const legacy = legacyAgentTasksSnapshot(real);
  assert.equal(legacy.limit, 4);
  assert.equal(real.limit, 10);
  const oldList = AGENT_TASKS_CODECS.get(AGENT_TASKS_ROUTES.list);
  const newList = AGENT_TASK_LIMIT_V2_CODECS.get(AGENT_TASK_LIMIT_V2_ROUTES.list);
  assert.ok(oldList && newList);
  assert.throws(() => oldList.response(200, real));
  const decodedNew = newList.response(200, real);
  const decodedOld = oldList.response(200, legacy);
  assert.ok(isAgentTasksSnapshot(decodedNew));
  assert.ok(isAgentTasksSnapshot(decodedOld));
  assert.equal(decodedNew.limit, 10);
  assert.equal(decodedOld.limit, 4);
  assert.equal(optionalTeamEvent({ type: "agent-tasks-changed-v2", snapshot: real })?.type, "agent-tasks-changed");
  assert.throws(() => agentTasksEvent({ type: "agent-tasks-changed", snapshot: real }));
  assert.equal(agentTasksEvent({ type: "agent-tasks-changed", snapshot: legacy })?.type, "agent-tasks-changed");
  for (const protocol of [1, 6, 7, 8]) {
    const capabilities = teamCapabilitiesForProtocol(protocol);
    assert.ok(!capabilities.includes(AGENT_TASK_LIMIT_V2_CAPABILITY));
    if (protocol >= 7) assert.ok(capabilities.length <= 128);
  }
  assert.ok(teamCapabilitiesForProtocol(9).includes(AGENT_TASK_LIMIT_V2_CAPABILITY));
  report.checks.push(
    "Released v1 codecs still reject 10; legacy projections remain 4; v2 list/event accept 10, and only protocol 9 advertises v2.",
  );
  await checkHttpRoutes(expanded.id);
  await closeAll(expanded.id);
  const standard = await create("Default");
  assert.equal(standard.taskLimit, undefined);
  const five = await startTasks(standard, 5);
  await waitFor(
    "the default four and queued fifth",
    () =>
      running(standard.id).length === 4 &&
      snapshot(standard.id).tasks.find((task) => task.id === five[4]?.id)?.hold === "task-limit",
  );
  report.peaks.default = running(standard.id).length;
  report.checks.push("An unconfigured agent still runs four tasks and queues the fifth.");
  await closeAll(standard.id);
  const serial = await create("Serial ACP", "acp");
  await runCauseEffect(service.updateAgent({ agentId: serial.id, taskLimit: 10 }));
  const pair = await startTasks(serial, 2);
  await waitFor(
    "one ACP task and serialized second",
    () =>
      running(serial.id).length === 1 &&
      snapshot(serial.id).tasks.find((task) => task.id === pair[1]?.id)?.hold === "one-turn",
  );
  assert.equal(snapshot(serial.id).limit, 1);
  report.peaks.serial = running(serial.id).length;
  await finishTask(serial.id, pair[0]?.id ?? "");
  await waitFor(
    "the second serial task",
    () => snapshot(serial.id).tasks.find((task) => task.id === pair[1]?.id)?.activeTurnId,
  );
  assert.equal(running(serial.id).length, 1);
  report.checks.push(
    "Real ACP agent scheduling stays serial with configured 10; finishing the first releases the second.",
  );
  await closeAll(serial.id);
  // The agent's own OpenBot tool has a separate unfinished-task guard from user-created threads.
  const creator = await create("Tool creator");
  const creatorMessage = await runCauseEffect(
    service.sendMessage({ agentId: creator.id, text: "Create controlled parallel tasks." }),
  );
  const creatorDelivery = creatorMessage.deliveries[0]?.id;
  assert.ok(creatorDelivery);
  const creatorTurn = await waitFor(
    "the tool creator's own turn",
    () => mailbox.getDelivery(creatorDelivery)?.delivery.turnId,
  );
  const creatorClient = clients.find((client) => [...client.active.values()].includes(creatorTurn));
  assert.ok(creatorClient);
  const creatorSession = [...creatorClient.active.entries()].find(([, turn]) => turn === creatorTurn)?.[0];
  assert.ok(creatorSession);
  const toolSucceeded = async (title: string) => {
    const result = await creatorClient.startTaskTool(creatorSession, title);
    assert.ok(isRecord(result), "the real tool router must return a structured tool response");
    return result.success === true;
  };
  for (let index = 1; index <= 8; index += 1) assert.equal(await toolSucceeded(`Tool task ${index}`), true);
  assert.equal(snapshot(creator.id).tasks.length, 8);
  assert.equal(await toolSucceeded("Default ninth must wait"), false);
  assert.equal(snapshot(creator.id).tasks.length, 8);
  assert.equal(snapshot(creator.id).limit, 4);
  await runCauseEffect(service.updateAgent({ agentId: creator.id, taskLimit: 9 }));
  assert.equal(await toolSucceeded("Tool task 9"), true);
  assert.equal(await toolSucceeded("Ninth-limit tenth refused"), false);
  assert.equal(snapshot(creator.id).tasks.length, 9);
  await runCauseEffect(service.updateAgent({ agentId: creator.id, taskLimit: 10 }));
  assert.equal(await toolSucceeded("Tool task 10"), true);
  assert.equal(await toolSucceeded("Eleventh tool task refused"), false);
  await waitFor("ten tasks created by the agent's own tool to run", () => running(creator.id).length === 10);
  assert.equal(snapshot(creator.id).tasks.length, 10);
  assert.ok(snapshot(creator.id).tasks.every((task) => task.origin === "agent"));
  assert.equal(new Set(running(creator.id).map((task) => task.activeTurnId)).size, 10);
  report.peaks.toolCreated = running(creator.id).length;
  report.checks.push(
    "Provider item/tool/call routes real start_task calls through the authenticated main-chat caller: default guard admits 8/refuses 9; configured 9 admits 9/refuses 10; configured 10 admits and runs 10/refuses 11.",
  );
  await closeAll(creator.id);
  creatorClient.finish(creatorSession);
  await waitFor(
    "the creator's own turn to finish",
    () => mailbox.getDelivery(creatorDelivery)?.delivery.status === "completed",
  );
  const sessionsBefore = eleven.flatMap((task) => database.listProviderSessions(task.threadId));
  assert.equal(sessionsBefore.length, 11);
  await runCauseEffect(service.stop());
  database.close();
  const reopened = new OpenBotDatabase(state);
  const reopenedAgents = new AgentStore(state, join(root, "home"), reopened);
  try {
    await runCauseEffect(reopenedAgents.initialize());
    assert.equal(reopenedAgents.list().find((agent) => agent.id === expanded.id)?.taskLimit, 10);
    assert.equal(reopenedAgents.list().find((agent) => agent.id === standard.id)?.taskLimit, undefined);
    const sessionsAfter = eleven.flatMap((task) => reopened.listProviderSessions(task.threadId));
    assert.deepEqual(sessionsAfter, sessionsBefore);
    assert.equal(reopenedAgents.list().find((agent) => agent.id === expanded.id)?.model, settingsBefore?.model);
  } finally {
    reopened.close();
  }
  report.checks.push(
    "Reopening the real SQLite/store preserves configured 10, default absence, provider session and model.",
  );
  report.passed = true;
} catch (failure) {
  report.error = failure instanceof Error ? failure.stack : String(failure);
  process.exitCode = 1;
} finally {
  await runCauseEffect(service.stop()).catch(() => {});
  database.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const out = resolve(".openbot-build/agent-task-limit-e2e");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(root, { recursive: true, force: true });
  // Machine-readable: finite E2E summary and evidence path.
  process.stdout.write(`${JSON.stringify({ ...report, report: join(out, "report.json") }, null, 2)}\n`);
}
