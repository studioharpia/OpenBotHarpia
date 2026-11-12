// Drives only this checkout's named OpenBot Dev instance. A temporary ACP process produces a long
// turn over real stdio/IPC; a controlled fixture message reproduces an independent mailbox reply.

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

declare global {
  interface Window {
    conversationCacheE2e?: { events: AgentEvent[]; unsubscribe: () => void };
  }
}
const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === process.cwd(),
);
assert(instance, "Start this checkout's dev app first.");
assert(instance.profile.startsWith("OpenBot Dev wt-"));
assertMutationAllowed({
  command: "conversation-live-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("conversation-live-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const { page } = connection;
page.setDefaultTimeout(20_000);
const root = await mkdtemp(join(tmpdir(), "openbot-live-cache-"));
const out = resolve(".openbot-build/conversation-live-dev-e2e");
await mkdir(out, { recursive: true });
const providerId = "history-cache-e2e";
const agentName = "Evidência — histórico estável";
let agentId: string | undefined;
let gate: ServerResponse | undefined;
function releaseGate(): void {
  gate?.end("continue");
  gate = undefined;
}
let checkpoint = "";
let cleaningUp = false;
const server = createServer((request, response) => {
  checkpoint = request.url ?? "";
  if (cleaningUp) response.end("cleanup");
  else gate = response;
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address === "object");
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks: string[] = [];
const report = {
  passed: false,
  checks,
  error: "",
  rendererErrors: errors,
  profile: instance.profile,
  url: page.url(),
};
try {
  const fake = join(out, "agent.ts");
  await writeFile(
    fake,
    `
import { serveFakeAcpAgent } from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};
let count = 0;
serveFakeAcpAgent({
  initialize: (request, peer) => peer.reply(request, { protocolVersion: 1, agentInfo: { name: "history-fixture", version: "1" }, agentCapabilities: { loadSession: true } }),
  "session/new": (request, peer) => peer.reply(request, { sessionId: "history-" + (++count), models: { availableModels: [{ modelId: "default", name: "Default" }], currentModelId: "default" } }),
  "session/load": (request, peer) => peer.reply(request, {}),
  "session/prompt": async (request, peer) => {
    const text = (request.params.prompt ?? []).map(p => p.text ?? "").join(" ");
    const id = request.params.sessionId;
    if (!text.includes("executar sequência controlada")) {
      peer.say(id, "Preparação concluída."); peer.reply(request, { stopReason: "end_turn" }); return;
    }
    const step = (index) => {
      peer.say(id, "Etapa preservada " + String(index).padStart(3, "0"));
      peer.update(id, { sessionUpdate: "tool_call", toolCallId: "tool-" + index, title: "Verificação " + index, kind: "read", status: "completed" });
    };
    for (let i = 1; i <= 105; i++) step(i);
    await fetch("http://127.0.0.1:${address.port}/ready");
    for (let i = 106; i <= 110; i++) step(i);
    await fetch("http://127.0.0.1:${address.port}/continued");
    peer.say(id, "Execução concluída com todas as etapas preservadas.");
    peer.reply(request, { stopReason: "end_turn" });
  },
});
`,
  );
  await page.evaluate(
    async ({ providerId, fake, command }) => {
      await window.openbot.customAgents.save({
        id: providerId,
        name: "History fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      });
    },
    { providerId, fake, command: process.execPath },
  );
  await page.waitForFunction(
    async (providerId) =>
      (await window.openbot.agent.listModels()).some((model) => model.id === `${providerId}/default`),
    providerId,
  );
  const created = await page.evaluate(
    async ({ providerId, agentName }) => {
      const agent = await window.openbot.agent.createAgent({
        name: agentName,
        description: "Teste temporário de regressão",
        avatarSeed: "history",
        avatarHue: null,
        initialMessage: "preparar",
        provider: "acp",
        model: `${providerId}/default`,
      });
      return agent;
    },
    { providerId, agentName },
  );
  agentId = created.id;
  const id = agentId;
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  const row = page.locator(`[data-chat-id="${id}"] > .agent-row`);
  await row.click();
  await page.evaluate(() => {
    const events: AgentEvent[] = [];
    const unsubscribe = window.openbot.agent.onEvent((event) => {
      events.push(event);
    });
    window.conversationCacheE2e = { events, unsubscribe };
  });
  await page.getByText("Preparação concluída.", { exact: true }).last().waitFor();
  await page.waitForFunction(
    async (agentId) => !(await window.openbot.agent.readConversation(agentId)).activeTurnId,
    id,
  );
  const threadId = await page.evaluate(
    async (agentId) => (await window.openbot.agent.readConversation(agentId)).threadId,
    id,
  );
  assert(threadId);
  const db = new Database(join(homedir(), "Library/Application Support", instance.profile, "openbot.db"));
  try {
    const createdAt = new Date(Date.now() + 300_000).toISOString();
    const message = {
      id: `standalone-${id}`,
      author: "agent",
      text: "Resposta independente de apoio — fixture",
      status: "completed",
      createdAt,
    };
    db.query(`INSERT INTO projection_thread_messages (thread_id,message_id,author,status,created_at,ordinal,message_json,last_event_sequence,group_start,group_first,group_id,turn_rank)
      VALUES (?,?,?,?,?,999,?,0,?,999,?,0)`).run(
      threadId,
      message.id,
      message.author,
      message.status,
      createdAt,
      JSON.stringify(message),
      createdAt,
      `message:${message.id}`,
    );
  } finally {
    db.close();
  }
  await page.evaluate(async (agentId) => {
    await window.openbot.agent.readConversation(agentId);
    await window.openbot.agent.sendMessage({
      agentId,
      text: "executar sequência controlada",
      clientMessageId: crypto.randomUUID(),
    });
  }, id);
  await page.waitForFunction(() =>
    window.conversationCacheE2e?.events.some(
      (event) =>
        event.type === "conversation" &&
        event.snapshot.messages.filter((m) => m.itemType === "commentary").length >= 105,
    ),
  );
  assert.equal(checkpoint, "/ready");
  await page.getByText("Etapa preservada 105", { exact: true }).last().waitFor();
  await page.screenshot({ path: join(out, "execucao-105.png") });
  report.checks.push("O renderer real mantém 105 comentários na mesma execução, com a mensagem independente presente.");
  const otherRow = page.locator('[data-chat-id="chief"] > .agent-row');
  await otherRow.click();
  await row.click();
  await page.getByText("Etapa preservada 105", { exact: true }).last().waitFor();
  const pageRead = await page.evaluate(
    (agentId) => window.openbot.agent.readConversationPage({ agentId, anchor: { type: "latest" }, limit: 50 }),
    id,
  );
  assert(pageRead.messages.some((m) => m.text === "Etapa preservada 105"));
  assert(pageRead.messages.length <= 100);
  report.checks.push("Sair e voltar ao chat carrega a etapa mais recente, sem mostrar apenas a mensagem independente.");
  releaseGate();
  await page.waitForFunction(() =>
    window.conversationCacheE2e?.events.some(
      (event) =>
        event.type === "conversation" &&
        event.snapshot.messages.filter((m) => m.itemType === "commentary").length >= 110,
    ),
  );
  assert.equal(checkpoint, "/continued");
  const all = await page.evaluate(async (agentId) => {
    const snapshots = (window.conversationCacheE2e?.events ?? []).filter(
      (event) => event.type === "conversation" && event.snapshot.agentId === agentId,
    );
    return snapshots.map((event) =>
      event.type === "conversation" ? event.snapshot.messages.filter((m) => m.itemType === "commentary").length : 0,
    );
  }, id);
  const at105 = all.findIndex((count) => count >= 105);
  assert(at105 >= 0 && all.slice(at105).every((count) => count >= 105));
  await page.getByText("Etapa preservada 110", { exact: true }).last().waitFor();
  await page.getByText("Etapa preservada 110", { exact: true }).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, "execucao-110.png") });
  report.checks.push(
    "Novas atualizações restauram as 110 etapas completas; nenhum snapshot regride após ultrapassar 105.",
  );
  releaseGate();
  await page.getByText("Execução concluída com todas as etapas preservadas.", { exact: true }).last().waitFor();
  await page
    .getByText("Execução concluída com todas as etapas preservadas.", { exact: true })
    .last()
    .scrollIntoViewIfNeeded();
  const durable = await page.evaluate((agentId) => window.openbot.agent.readConversation(agentId), id);
  assert.equal(durable.messages.filter((m) => m.itemType === "commentary").length, 110);
  assert.equal(durable.activeTurnId, null);
  assert.equal((await page.evaluate((agentId) => window.openbot.agent.listTasks(agentId), id)).tasks.length, 0);
  await page.screenshot({ path: join(out, "final.png") });
  report.checks.push(
    "Resposta final, 110 comentários persistidos e nenhuma subtarefa criada; execução termina normalmente.",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (failure) {
  report.error = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
  await page.screenshot({ path: join(out, "falha.png") }).catch(() => {});
} finally {
  cleaningUp = true;
  releaseGate();
  if (agentId)
    await page
      .waitForFunction(async (agentId) => !(await window.openbot.agent.readConversation(agentId)).activeTurnId, agentId)
      .catch(() => {});
  await page
    .evaluate(
      async ({ agentId, providerId }) => {
        window.conversationCacheE2e?.unsubscribe();
        delete window.conversationCacheE2e;
        if (agentId) {
          const snapshot = await window.openbot.agent.readConversation(agentId);
          if (snapshot.activeTurnId) await window.openbot.agent.interrupt({ agentId, turnId: snapshot.activeTurnId });
          await window.openbot.agent.deleteAgent(agentId);
        }
        await window.openbot.customAgents.delete({ id: providerId });
      },
      { agentId, providerId },
    )
    .catch((error: Error) => {
      report.error += ` Cleanup: ${error.message}`;
      report.passed = false;
      process.exitCode = 1;
    });
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await connection.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
