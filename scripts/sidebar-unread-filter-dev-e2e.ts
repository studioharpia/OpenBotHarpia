// Real dev sidebar unread filtering and persistence, without OS mouse input.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const named = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === named && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "sidebar-unread-filter-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  target: named,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("sidebar-unread-filter-dev-e2e"),
  {
    expectedRendererPort: instance.rendererPort,
    ownerPid: instance.pid,
  },
);
const { page } = connection;
page.setDefaultTimeout(12_000);
const out = resolve("specs/evidencias/sidebar-nao-lidas");
await mkdir(out, { recursive: true });
const original = await page.evaluate(() => localStorage.getItem("openbot:sidebar-unread-only"));
const originalPlacement = await page.evaluate(() => localStorage.getItem("openbot:thread-placement"));
const providerId = `density-${Date.now()}`;
let fixtureId: string | undefined;
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report: {
  passed: boolean;
  url: string;
  profile: string;
  checks: string[];
  errors: string[];
  failure: string;
  sizes: { mode: string; avatarWidth: number; avatarHeight: number; rowHeight: number; sidebarWidth: number }[];
} = { passed: false, url: page.url(), profile: instance.profile, checks, errors, failure: "", sizes: [] };
try {
  // Start from a fresh renderer after the shared Layout provider changed, avoiding stale HMR contexts.
  await page.locator(".sidebar-unread-filter-button").waitFor({ timeout: 30000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const toggle = page.locator(".sidebar-unread-filter-button");
  await toggle.waitFor();
  const fake = resolve(".openbot-build/sidebar-density-provider.ts");
  await writeFile(
    fake,
    `import {serveFakeAcpAgent} from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};let n=0;serveFakeAcpAgent({initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"density-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),"session/new":(r,p)=>p.reply(r,{sessionId:"density-"+(++n),models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),"session/load":(r,p)=>p.reply(r,{}),"session/prompt":(r,p)=>{p.say(r.params.sessionId,"Mensagem não lida para conferir a lista compacta.");p.reply(r,{stopReason:"end_turn"});}});`,
  );
  await page.evaluate(
    async ({ id, fake, command }) => {
      await window.openbot.customAgents.save({
        id,
        name: "Density fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      });
      await window.openbot.refreshAgentProviders({ automatic: false });
    },
    { id: providerId, fake, command: process.execPath },
  );
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      assert(Date.now() < deadline, "Fixture state timed out");
      await delay(30);
    }
  };
  await until(() =>
    page.evaluate(
      async (id) => (await window.openbot.agent.listModels()).some((model) => model.id === `${id}/default`),
      providerId,
    ),
  );
  const fixture = await page.evaluate(
    (id) =>
      window.openbot.agent.createAgent(
        {
          name: "Evidência não lidas",
          description: "Conferência temporária",
          avatarSeed: "density",
          avatarHue: null,
          initialMessage: "Conferir lista.",
          provider: "acp",
          model: `${id}/default`,
        },
        "local",
      ),
    providerId,
  );
  fixtureId = fixture.id;
  await page.evaluate((input) => window.openbot.agent.updateAgent(input, "local"), {
    agentId: fixture.id,
    title: "Teste",
  });
  await until(() =>
    page.evaluate(async (id) => {
      const chat = await window.openbot.agent.readConversation(id);
      return !chat.activeTurnId && chat.messages.some((message) => message.author === "assistant");
    }, fixture.id),
  );
  const answer = await page.evaluate(
    async (id) =>
      (await window.openbot.agent.readConversation(id)).messages.findLast((message) => message.author === "assistant"),
    fixture.id,
  );
  assert(answer);
  await page.evaluate((input) => window.openbot.agent.markConversationUnread(input, "local"), {
    agentId: fixture.id,
    fromMessageId: answer.id,
  });
  const click = () =>
    toggle.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  if ((await toggle.getAttribute("aria-pressed")) === "true") await click();
  const row = page.locator(`.agent-row[data-task-transfer-agent="${fixture.id}"]`);
  await row.waitFor();
  const channelRows = await page
    .locator(".sidebar-agent-item[data-chat-id]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-chat-id")));
  const channelData = await page.evaluate(() => window.openbot.agent.listChannels("local"));
  const before = await page.locator(".sidebar-agent-item > .agent-row").count();
  await click();
  await until(async () => (await toggle.getAttribute("aria-pressed")) === "true");
  await row.waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("openbot:sidebar-unread-only")), "true");
  assert((await page.locator(".sidebar-agent-item > .agent-row").count()) < before);
  checks.push("Ativar ocultou agentes lidos e manteve o agente temporário não lido.");
  for (const id of channelRows) {
    const channel = channelData.find((item) => item.id === id);
    if (channel)
      assert.equal(
        await page.locator(`.sidebar-agent-item[data-chat-id="${id}"]`).count(),
        channel.unreadCount > 0 ? 1 : 0,
      );
  }
  checks.push("Canais/grupos presentes na lista respeitaram sua contagem real de não lidas.");
  const cdp = await page.context().newCDPSession(page);
  const capture = async (name: string) => {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const box = await page.locator("#agent-sidebar").boundingBox();
    assert(box);
    const zoom = metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth;
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: {
        x: box.x * zoom,
        y: box.y * zoom,
        width: box.width * zoom,
        height: Math.min(650, metrics.layoutViewport.clientHeight),
        scale: 1,
      },
    });
    await writeFile(resolve(out, name), Buffer.from(screenshot.data, "base64"));
  };
  await capture("01-filtro-ativo.png");
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  await row.waitFor();
  checks.push("Filtro persistiu após recarregar o renderer real.");
  // Branch an owned task so the main chat can be read while the task remains unread.
  const task = await page.evaluate(
    async ({ agentId, messageId }) => {
      const task = await window.openbot.agent.branchTask(
        { agentId, taskId: null, messageId, requestId: crypto.randomUUID() },
        "local",
      );
      await window.openbot.agent.renameTask({ agentId, taskId: task.id, title: "Evidência tarefa não lida" }, "local");
      const history = await window.openbot.agent.readTask({ agentId, taskId: task.id }, "local");
      const boundary = history.messages.findLast((message) => message.author === "assistant")?.id;
      if (!boundary) throw new Error("Owned task needs an assistant message.");
      await window.openbot.agent.markTaskUnread({ agentId, taskId: task.id, fromMessageId: boundary }, "local");
      await window.openbot.agent.markConversationRead({ agentId, throughMessageId: messageId }, "local");
      return { ...task, boundary };
    },
    { agentId: fixture.id, messageId: answer.id },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  await row.waitFor();
  checks.push(
    "Agente com principal lida permaneceu visível pela tarefa não lida, independente da posição dos tópicos.",
  );
  await page.evaluate(() => {
    localStorage.setItem("openbot:thread-placement", "sidebar");
    window.dispatchEvent(new StorageEvent("storage", { key: "openbot:thread-placement" }));
  });
  const taskRow = page.getByRole("button", { name: /Evidência tarefa não lida/ });
  await taskRow.waitFor();
  await capture("02-tarefa-nao-lida.png");
  await page.evaluate(
    async ({ agentId, taskId, messageId }) => {
      await window.openbot.agent.markTaskRead({ agentId, taskId, throughMessageId: messageId }, "local");
    },
    { agentId: fixture.id, taskId: task.id, messageId: task.boundary },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  await until(async () => (await row.count()) === 0);
  checks.push("Ao ler a última tarefa não lida, agente saiu da lista filtrada.");
  await click();
  await row.waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("openbot:sidebar-unread-only")), "false");
  checks.push("Desativar restaurou os agentes lidos sem excluir conversas.");
  await page.evaluate((value) => {
    if (value === null) localStorage.removeItem("openbot:thread-placement");
    else localStorage.setItem("openbot:thread-placement", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "openbot:thread-placement" }));
  }, originalPlacement);
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await page
    .evaluate((value) => {
      if (value === null) localStorage.removeItem("openbot:thread-placement");
      else localStorage.setItem("openbot:thread-placement", value);
      window.dispatchEvent(new StorageEvent("storage", { key: "openbot:thread-placement" }));
    }, originalPlacement)
    .catch(() => undefined);
  await page
    .evaluate(
      async ({ id, providerId }) => {
        if (id) await window.openbot.agent.deleteAgent(id);
        await window.openbot.customAgents.delete({ id: providerId });
      },
      { id: fixtureId, providerId },
    )
    .catch((error: Error) => {
      report.passed = false;
      report.failure += error.message;
      process.exitCode = 1;
    });
  await page.evaluate((value) => {
    if (value === null) localStorage.removeItem("openbot:sidebar-unread-only");
    else localStorage.setItem("openbot:sidebar-unread-only", value);
    window.dispatchEvent(new StorageEvent("storage", { key: "openbot:sidebar-unread-only" }));
  }, original);
  await writeFile(resolve(out, "resultado.json"), JSON.stringify(report, null, 2));
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
