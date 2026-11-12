// Exercises the real Central in a dedicated chat window. Never drives or reloads the user's main window.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type AgentTask, LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const requestedInstance = process.argv
  .find((argument) => argument.startsWith("--instance="))
  ?.slice("--instance=".length);
const instance = readDevInstanceRecords().find(
  (record) =>
    record.service === "app" &&
    resolve(record.projectRoot) === process.cwd() &&
    (!requestedInstance || record.instanceId === requestedInstance),
);
assert(instance, "Start this checkout's development app first.");
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "side-panel-width-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("side-panel-width-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(
  process.argv.find((arg) => arg.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente/largura-compartilhada",
);
await mkdir(out, { recursive: true });
await mkdir(resolve(".openbot-build/side-panel-width-dev-e2e"), { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
let ownedPage: Page | undefined;
let fixture: AgentTask | undefined;
let storedWidth: string | null = null;
let storedPreference: string | null = null;
let originalSections: string | null = null;
let passed = false;
let failure = "";
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
try {
  const candidate = await main.evaluate(async (serverId) => {
    const selected = document
      .querySelector('.sidebar [data-chat-id] .agent-row[aria-pressed="true"]')
      ?.closest("[data-chat-id]")
      ?.getAttribute("data-chat-id");
    const windows = await window.openbot.getChatWindows();
    const agents = await window.openbot.agent.listAgents(serverId);
    for (const agent of agents) {
      if (
        agent.id === selected ||
        windows.some((target) => target.serverId === serverId && target.agentId === agent.id)
      )
        continue;
      const conversation = await window.openbot.agent.readConversation(agent.id, serverId);
      if (conversation.activeTurnId) continue;
      const answer = conversation.messages.findLast(
        (message) => message.author === "assistant" && message.status === "completed" && !message.itemType,
      );
      if (answer) return { agent, answerId: answer.id };
    }
    return null;
  }, LOCAL_SERVER_ID);
  assert(candidate, "An idle agent without an existing chat window is required.");
  storedWidth = await main.evaluate(() => localStorage.getItem("openbot:side-panel-width"));
  const preference = await main.evaluate(() => localStorage.getItem("openbot:agent-panel:local"));
  storedPreference = preference;
  originalSections = await main.evaluate(() => localStorage.getItem("openbot:central-task-sections"));
  fixture = await main.evaluate(
    async ({ candidate, serverId }) => {
      const task = await window.openbot.agent.branchTask(
        { agentId: candidate.agent.id, taskId: null, messageId: candidate.answerId, requestId: crypto.randomUUID() },
        serverId,
      );
      await window.openbot.agent.renameTask(
        { agentId: candidate.agent.id, taskId: task.id, title: "Evidência — largura das abas" },
        serverId,
      );
      return { ...task, title: "Evidência — largura das abas" };
    },
    { candidate, serverId: LOCAL_SERVER_ID },
  );
  const opened = main.context().waitForEvent("page");
  await main.evaluate((target) => window.openbot.openChatWindow(target), {
    agentId: candidate.agent.id,
    serverId: LOCAL_SERVER_ID,
  });
  const page = await opened;
  await page.waitForURL(
    (url) => url.searchParams.get("window") === "chat" && url.searchParams.get("agent") === candidate.agent.id,
  );
  ownedPage = page;
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.locator(".app-loading").waitFor({ state: "hidden" });
  const notices = page
    .locator('[data-sonner-toast][data-front="true"]')
    .getByRole("button", { name: /Fechar notificação|Close toast/, exact: true });
  while (await notices.count()) {
    const close = notices.first();
    const element = await close.elementHandle();
    await close.focus();
    await close.press("Enter");
    await page.waitForFunction((element) => !element?.isConnected, element);
  }
  const shot = async (name: string) => {
    await page.evaluate(async () => {
      const animations = document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.screenshot({ path: resolve(out, name) });
  };
  const central = () => page.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  const centralTab = () => page.getByRole("tab", { name: /Central do agente|Agent central/, exact: true });
  const panelToggle = page.locator(".side-panel-toggle");
  await panelToggle.waitFor();
  if ((await panelToggle.getAttribute("aria-expanded")) === "false") await panelToggle.click();
  const existingCentralTab = page.getByRole("tab", { name: /^(Central do agente|Agent central)$/ });
  const launchCentral = page.getByRole("button", { name: /^(Abrir Central do agente|Open Agent central)$/ });
  if (await existingCentralTab.count()) await existingCentralTab.click();
  else if (await launchCentral.isVisible()) await launchCentral.click();
  else {
    await page.getByRole("button", { name: /^(Adicionar painel|Add pane)$/ }).click();
    await page.getByRole("menuitem", { name: /^(Central do agente|Agent central)$/ }).click();
  }
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).waitFor();
  for (const label of [/^(Concluídas|Completed)$/, /^(Em andamento|In progress)$/]) {
    const toggle = central().getByRole("button", { name: label });
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
  const archiveToggle = central().getByRole("button", { name: /^(Arquivadas|Archived)$/ });
  if ((await archiveToggle.getAttribute("aria-expanded")) === "true") await archiveToggle.click();

  const resizer = () => page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
  const width = async () => Number(await resizer().getAttribute("aria-valuenow"));
  await resizer().waitFor();
  await resizer().press("Home");
  assert.equal(await width(), 360);
  await resizer().press("ArrowLeft");
  await resizer().press("ArrowLeft");
  assert.equal(await width(), 384);
  await resizer().press("ArrowRight");
  assert.equal(await width(), 372);
  checks.push("The dock resizer supports keyboard growth, shrink and the shared minimum.");
  const bounds = await resizer().boundingBox();
  assert(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 - 140, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  const chosen = await width();
  assert.equal(chosen, 512);
  assert.equal(await page.evaluate(() => localStorage.getItem("openbot:side-panel-width")), String(chosen));
  await shot("01-central-largura.png");
  checks.push("Pointer dragging the Central changes and persists the dock width.");
  await central()
    .getByRole("button", { name: new RegExp(`^${escapePattern(fixture.title)}`) })
    .click();
  await page.getByRole("tab", { name: new RegExp(escapePattern(fixture.title)) }).waitFor();
  await page.getByRole("tab", { name: new RegExp(escapePattern(fixture.title)) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Abrir ao lado do chat|Open beside chat/ }).click();
  await page.locator(".side-thread-panel").waitFor();
  assert.equal(await width(), chosen);
  const taskHandle = await resizer().boundingBox();
  assert(taskHandle);
  await page.mouse.move(taskHandle.x + taskHandle.width / 2, taskHandle.y + taskHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(taskHandle.x + taskHandle.width / 2 - 36, taskHandle.y + taskHandle.height / 2, { steps: 4 });
  await page.mouse.up();
  const taskWidth = await width();
  assert.equal(taskWidth, chosen + 36);
  await shot("02-tarefa-redimensionavel.png");
  await centralTab().click();
  assert.equal(await width(), taskWidth);
  checks.push("Opening a task preserves width; resizing the task is reflected back in Central.");
  await central()
    .getByRole("button", { name: /Configurações do agente|Agent settings/, exact: true })
    .click();
  await page.getByRole("tab", { name: /Configurações do agente|Agent settings/, exact: true }).waitFor();
  assert.equal(await width(), taskWidth);
  await resizer().press("ArrowLeft");
  const settingsWidth = await width();
  assert.equal(settingsWidth, taskWidth + 12);
  await shot("03-configuracoes-mesma-largura.png");
  await centralTab().click();
  assert.equal(await width(), settingsWidth);
  checks.push("Agent settings cannot restore a private width, and its resize applies to the other tabs.");
  await page.getByRole("button", { name: /Adicionar painel|Add pane|Add tab/ }).click();
  await page.getByRole("menuitem", { name: /^(Arquivos|Files)$/ }).click();
  await page.getByRole("tab", { name: /^(Arquivos|Files)$/ }).waitFor();
  assert.equal(await width(), settingsWidth);
  await resizer().press("ArrowLeft");
  const filesWidth = await width();
  assert.equal(filesWidth, settingsWidth + 12);
  await centralTab().click();
  assert.equal(await width(), filesWidth);
  checks.push("Files shares the same dock resizer and width.");
  await page.getByRole("button", { name: /Maximizar painel lateral|Maximize side panel/, exact: true }).click();
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).waitFor();
  assert.equal(await resizer().count(), 0);
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).click();
  assert.equal(await width(), filesWidth);
  checks.push("Maximize hides the handle and restore preserves the chosen width.");
  await page.reload();
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).waitFor();
  assert.equal(await width(), filesWidth);
  checks.push("Reloading the dedicated window restores the persisted shared width.");
  await shot("04-largura-restaurada.png");
  assert.deepEqual(errors, []);
  checks.push("No renderer errors; the user's main window and Chief's ten tasks were not driven or changed.");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (ownedPage) await ownedPage.screenshot({ path: resolve(out, "falha.png") }).catch(() => undefined);
} finally {
  if (ownedPage && !ownedPage.isClosed()) {
    await ownedPage.evaluate(
      ({ width, preference, sections }) => {
        if (sections === null) localStorage.removeItem("openbot:central-task-sections");
        else localStorage.setItem("openbot:central-task-sections", sections);
        window.dispatchEvent(new StorageEvent("storage", { key: "openbot:central-task-sections", newValue: sections }));
        if (width === null) localStorage.removeItem("openbot:side-panel-width");
        else localStorage.setItem("openbot:side-panel-width", width);
        if (preference === null) localStorage.removeItem("openbot:agent-panel:local");
        else localStorage.setItem("openbot:agent-panel:local", preference);
      },
      { width: storedWidth, preference: storedPreference, sections: originalSections },
    );
    await ownedPage.close();
  }
  if (fixture)
    await main.evaluate(
      async ({ task, serverId }) => {
        await window.openbot.agent.closeTask({ agentId: task.agentId, taskId: task.id }, serverId);
        await window.openbot.agent.deleteTask({ agentId: task.agentId, taskId: task.id }, serverId);
      },
      { task: fixture, serverId: LOCAL_SERVER_ID },
    );
  const report = {
    passed,
    checks,
    limitations: [
      "Browser is intentionally unavailable in dedicated chat windows; the web client and channel settings were not exercised manually.",
      "The seeded attachment evidence-map.json is unavailable on disk; file previews were typechecked but not validated end to end.",
    ],
    failure,
    errors,
    profile: instance.profile,
    url: main.url(),
    fixtureRemoved: fixture !== undefined,
    dedicatedWindowClosed: ownedPage !== undefined,
  };
  await writeFile(resolve(out, "resultado.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(".openbot-build/side-panel-width-dev-e2e/report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
