// Real dev renderer, preload and IPC. Only a temporary branch is created; no provider turn is sent.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTask } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === process.cwd(),
);
assert(instance, "Start this checkout's isolated dev app first.");
assert(instance.profile.startsWith("OpenBot Dev wt-"), "Use this checkout's isolated dev profile.");
assertMutationAllowed({
  command: "agent-central-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("agent-central-dev-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = connection;
page.setDefaultTimeout(15_000);
const out = resolve(".openbot-build/agent-central-dev-e2e");
const evidence = resolve(
  process.argv.find((argument) => argument.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente",
);
await mkdir(out, { recursive: true });
await mkdir(evidence, { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let fixture: AgentTask | undefined;
let originalPreference: { key: string; value: string | null } | undefined;
const centralTab = () => page.getByRole("tab", { name: /Central do agente|Agent central/, exact: true });
const settingsTab = () => page.getByRole("tab", { name: /Configurações do agente|Agent settings/, exact: true });
const central = () => page.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
const select = async (id: string) => {
  await page.locator(`[data-chat-id="${id}"] > .agent-row`).click();
};
const selected = async (tab: ReturnType<typeof centralTab>) => {
  await tab.waitFor();
  await page.waitForFunction((element) => element?.getAttribute("aria-selected") === "true", await tab.elementHandle());
};
const dismissNotices = async () => {
  const close = page
    .locator('[data-sonner-toast][data-front="true"]')
    .getByRole("button", { name: /Fechar notificação|Close toast/, exact: true });
  while (await close.count()) {
    const button = close.first();
    const element = await button.elementHandle();
    await button.focus();
    await button.press("Enter");
    await page.waitForFunction((element) => !element?.isConnected, element);
  }
};
const reload = async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Agentes|Agents/, exact: true }).waitFor();
  await page.locator(".agent-row").first().waitFor();
  await page.locator(".app-loading").waitFor({ state: "hidden" });
  await dismissNotices();
};
let passed = false;
let failure = "";
try {
  await page.bringToFront();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator(".app-loading").waitFor({ state: "hidden" });
  await dismissNotices();
  await page.getByRole("button", { name: /Agentes|Agents/, exact: true }).click();
  const agents = await page.evaluate(async () => {
    const list = await window.openbot.agent.listAgents();
    for (const agent of list) {
      const snapshot = await window.openbot.agent.readConversation(agent.id);
      if (snapshot.activeTurnId) continue;
      const answer = snapshot.messages.findLast(
        (message) => message.author === "assistant" && message.status === "completed" && !message.itemType,
      );
      const other = list.find((item) => item.id !== agent.id);
      if (answer && other) return { owner: agent, other, answerId: answer.id };
    }
    return null;
  });
  assert(agents, "Two dev agents and one completed answer are required.");
  originalPreference = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) => key.startsWith("openbot:agent-panel:"));
    if (!key) throw new Error("The agent panel preference was not initialized.");
    const value = localStorage.getItem(key);
    localStorage.removeItem(key);
    return { key, value };
  });
  await reload();
  await select(agents.owner.id);
  await selected(centralTab());
  const mainChat = page.getByRole("button", { name: /Abrir o chat principal|Open main chat/, exact: true });
  if (await mainChat.isVisible()) await mainChat.click();
  await central().getByRole("heading", { name: agents.owner.name, exact: true }).waitFor();
  if (agents.owner.title) await central().getByText(agents.owner.title, { exact: true }).waitFor();
  await page.getByRole("textbox", { name: new RegExp(`^(Mensagem para|Message) ${agents.owner.name}$`) }).waitFor();
  checks.push("Central opens by default beside the main chat and names the selected agent.");
  await central()
    .getByRole("img", { name: /Atividade de tokens|Token activity/, exact: true })
    .waitFor();
  assert.equal(
    await central()
      .getByText(/Dados parciais|O uso de contexto ainda não foi informado/)
      .count(),
    0,
  );
  checks.push(
    "Profile shows the agent's title; token activity renders as a compact monthly heatmap beside the metric cards, without the removed warnings.",
  );

  await page.getByRole("button", { name: /Adicionar painel|Add pane/, exact: true }).click();
  const menu = page.getByRole("menu").last();
  for (const name of [/Navegador|Browser/, /Arquivos|Files/, /Configurações do agente|Agent settings/, /Voz|Voice/])
    await menu.getByRole("menuitem", { name }).waitFor();
  await page.screenshot({ path: resolve(evidence, "01-central-menu.png") });
  await page.keyboard.press("Escape");
  checks.push("The existing browser, files, settings and voice options remain in Add.");

  await central()
    .getByRole("button", { name: /Configurações do agente|Agent settings/ })
    .click();
  await selected(settingsTab());
  await select(agents.other.id);
  await selected(settingsTab());
  const nameField = page.getByRole("textbox", { name: /Nome|Name/, exact: true });
  await page.waitForFunction(
    ({ expected }) => [...document.querySelectorAll("input")].some((input) => input.value === expected),
    { expected: agents.other.name },
  );
  assert.equal(await nameField.inputValue(), agents.other.name);
  await page.screenshot({ path: resolve(evidence, "02-configuracoes-outro-agente.png") });
  await select(agents.owner.id);
  await selected(settingsTab());
  assert.equal(await nameField.inputValue(), agents.owner.name);
  checks.push("Settings stays open across agents, with each agent's own field values.");

  await reload();
  await select(agents.other.id);
  await selected(settingsTab());
  assert.equal(await nameField.inputValue(), agents.other.name);
  checks.push("The settings preference survives a renderer reload.");

  await page.locator(".conversation-header .side-panel-toggle").click();
  await select(agents.owner.id);
  await page.locator(".side-panel-header").waitFor({ state: "detached" });
  await reload();
  await select(agents.other.id);
  await page.locator(".side-panel-header").waitFor({ state: "detached" });
  checks.push("Explicit collapse stays closed on another agent and after reload.");
  await page.locator(".conversation-header .side-panel-toggle").click();
  await page.getByRole("button", { name: /Abrir Central do agente|Open Agent central/, exact: true }).click();
  await selected(centralTab());
  await select(agents.owner.id);
  await selected(centralTab());
  checks.push("Selecting Central replaces the shared settings/closed preference.");

  fixture = await page.evaluate(async ({ owner, answerId }) => {
    const task = await window.openbot.agent.branchTask({
      agentId: owner.id,
      taskId: null,
      messageId: answerId,
      requestId: crypto.randomUUID(),
    });
    await window.openbot.agent.renameTask({
      agentId: owner.id,
      taskId: task.id,
      title: "Evidência — tarefa da Central",
    });
    return { ...task, title: "Evidência — tarefa da Central" };
  }, agents);
  await central()
    .getByRole("button", { name: new RegExp(fixture.title) })
    .waitFor();
  await page.screenshot({ path: resolve(evidence, "03-central-com-tarefa.png") });
  await central()
    .getByRole("button", { name: new RegExp(fixture.title) })
    .click();
  await page.getByRole("tab", { name: new RegExp(fixture.title) }).waitFor();
  await page.getByRole("textbox", { name: new RegExp(fixture.title) }).waitFor();
  checks.push(
    "A real persisted task appears in Central and opens in the main column, preserving Central on the right.",
  );
  await centralTab().click();
  await selected(centralTab());
  await central()
    .getByRole("button", { name: /Nova tarefa|New task/, exact: true })
    .click();
  await page
    .getByRole("textbox", { name: new RegExp(`^(Novo tópico com|New thread with) ${agents.owner.name}$`) })
    .waitFor();
  checks.push("New task reuses the existing draft composer without sending a provider turn.");
  await page.getByRole("button", { name: /Abrir o chat principal|Open main chat/, exact: true }).click();

  await page.getByRole("button", { name: /Maximizar painel lateral|Maximize side panel/, exact: true }).click();
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).waitFor();
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).click();
  checks.push("Central keeps the existing maximize and restore actions.");
  await select(agents.other.id);
  await central().getByRole("heading", { name: agents.other.name, exact: true }).waitFor();
  assert.equal(
    await central()
      .getByRole("button", { name: new RegExp(fixture.title) })
      .count(),
    0,
  );
  checks.push("Tasks and content never leak into another agent's Central.");
  const channel = await page.evaluate(async () => (await window.openbot.agent.listChannels())[0] ?? null);
  if (channel) {
    await page.locator(`[data-chat-id="${channel.id}"] > .agent-row`).click();
    await page.getByRole("heading", { name: channel.name, exact: true }).waitFor();
    assert.equal(await centralTab().count(), 0);
    checks.push("Channels keep their own panels and do not inherit the agent's Central.");
  }
  await select(agents.owner.id);
  await selected(centralTab());
  assert.deepEqual(errors, []);
  checks.push("No renderer page errors during the affected flow.");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  await page.screenshot({ path: resolve(evidence, "falha.png") }).catch(() => undefined);
} finally {
  if (fixture)
    await page.evaluate(async (task) => {
      await window.openbot.agent.closeTask({ agentId: task.agentId, taskId: task.id });
      await window.openbot.agent.deleteTask({ agentId: task.agentId, taskId: task.id });
    }, fixture);
  if (originalPreference)
    await page.evaluate(({ key, value }) => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }, originalPreference);
  const report = {
    passed,
    checks,
    failure,
    errors,
    url: page.url(),
    profile: instance.profile,
    instance: instance.instanceId,
  };
  await writeFile(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(evidence, "resultado.json"), `${JSON.stringify(report, null, 2)}\n`);
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
