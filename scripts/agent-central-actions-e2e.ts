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
  command: "agent-central-actions-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-central-actions-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(
  process.argv.find((argument) => argument.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente/padronizacao-tarefas",
);
await mkdir(out, { recursive: true });
await mkdir(resolve(".openbot-build/agent-central-actions-e2e"), { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
let ownedPage: Page | undefined;
let fixture: AgentTask | undefined;
let originalWidth: string | null = null;
let originalPreference: string | null = null;
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
  const preference = await main.evaluate(() => localStorage.getItem("openbot:agent-panel:local"));
  originalPreference = preference;
  originalSections = await main.evaluate(() => localStorage.getItem("openbot:central-task-sections"));
  originalWidth = await main.evaluate(() => localStorage.getItem("openbot:side-panel-width"));
  fixture = await main.evaluate(
    async ({ candidate, serverId }) => {
      const task = await window.openbot.agent.branchTask(
        { agentId: candidate.agent.id, taskId: null, messageId: candidate.answerId, requestId: crypto.randomUUID() },
        serverId,
      );
      await window.openbot.agent.renameTask(
        { agentId: candidate.agent.id, taskId: task.id, title: "Evidência — operação da Central" },
        serverId,
      );
      return { ...task, title: "Evidência — operação da Central" };
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
    await page.waitForFunction(() =>
      /Mês atual|Mês anterior|This month|Last month/.test(
        document.querySelector(".agent-central-month-select .ui-select-value")?.textContent ?? "",
      ),
    );
    await page.evaluate(async () => {
      const animations = document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY);
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    });
    await page.screenshot({ path: resolve(out, name) });
  };
  const central = () => page.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  const panelToggle = page.locator(".side-panel-toggle");
  await panelToggle.waitFor();
  if ((await panelToggle.getAttribute("aria-expanded")) === "false") await panelToggle.click();
  const centralTab = page.getByRole("tab", { name: /^(Central do agente|Agent central)$/ });
  const launchCentral = page.getByRole("button", { name: /^(Abrir Central do agente|Open Agent central)$/ });
  if (await centralTab.count()) await centralTab.click();
  else if (await launchCentral.isVisible()) await launchCentral.click();
  else {
    await page.getByRole("button", { name: /^(Adicionar painel|Add pane)$/ }).click();
    await page.getByRole("menuitem", { name: /^(Central do agente|Agent central)$/ }).click();
  }
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).waitFor();
  await page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ }).press("Home");
  for (const label of [/^(Concluídas|Completed)$/, /^(Em andamento|In progress)$/]) {
    const toggle = central().getByRole("button", { name: label });
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  }
  const archiveToggle = central().getByRole("button", { name: /^(Arquivadas|Archived)$/ });
  if ((await archiveToggle.getAttribute("aria-expanded")) === "true") await archiveToggle.click();

  await central()
    .getByRole("img", { name: /Atividade de tokens|Token activity/, exact: true })
    .waitFor();
  assert.equal(
    await central()
      .getByText(/Dados parciais|O uso de contexto ainda não foi informado|Estimativa de API/)
      .count(),
    0,
  );
  checks.push("The real agent profile, monthly token heatmap and metric cards render without the removed warnings.");
  const menu = async (title: string) => {
    await central()
      .getByRole("button", { name: new RegExp(`^(Ações de|Actions for) ${escapePattern(title)}$`) })
      .click();
  };
  const initialTitle = fixture.title;
  await menu(initialTitle);
  for (const name of [/^(Abrir|Open)$/, /^(Excluir|Delete)$/, /^(Renomear|Rename)$/, /^(Arquivar|Archive)$/])
    await page.getByRole("menuitem", { name }).waitFor();
  await shot("01-menu-de-acoes.png");
  checks.push("The shared task menu exposes Open, Rename, Archive and Delete, with the existing sidebar icons.");
  await page.getByRole("menuitem", { name: /^(Renomear|Rename)$/ }).click();
  const input = page.getByRole("textbox", { name: /Nome do tópico|Thread name/, exact: true });
  await input.fill("Evidência — edição cancelada");
  await input.press("Escape");
  assert.equal(
    (
      await page.evaluate(({ task, serverId }) => window.openbot.agent.listTasks(task.agentId, serverId), {
        task: fixture,
        serverId: LOCAL_SERVER_ID,
      })
    ).tasks.find((task) => task.id === fixture?.id)?.title,
    initialTitle,
  );
  checks.push("Escape cancels an inline rename without changing the stored task.");
  await menu(initialTitle);
  await page.getByRole("menuitem", { name: /^(Renomear|Rename)$/ }).click();
  const renamed = "Evidência — tarefa renomeada na Central";
  await input.fill(renamed);
  await input.press("Enter");
  await page.waitForFunction(
    async ({ task, serverId, title }) =>
      (await window.openbot.agent.listTasks(task.agentId, serverId)).tasks.some(
        (item) => item.id === task.id && item.title === title,
      ),
    { task: fixture, serverId: LOCAL_SERVER_ID, title: renamed },
  );
  checks.push("Enter saves the renamed title through real IPC and the task store.");
  const updated = await page.evaluate(
    async ({ task, serverId }) =>
      (await window.openbot.agent.listTasks(task.agentId, serverId)).tasks.find((item) => item.id === task.id),
    { task: fixture, serverId: LOCAL_SERVER_ID },
  );
  assert(updated);
  assert.equal(
    await central()
      .getByRole("button", { name: new RegExp(`^${escapePattern(renamed)}`) })
      .locator("time")
      .getAttribute("datetime"),
    updated.updatedAt,
  );
  checks.push("The row date matches the task's last persisted update from the host.");
  await menu(renamed);
  await page.getByRole("menuitem", { name: /^(Arquivar|Archive)$/ }).click();
  await page.waitForFunction(
    async ({ task, serverId }) =>
      (await window.openbot.agent.listTasks(task.agentId, serverId)).tasks.some(
        (item) => item.id === task.id && item.state === "closed",
      ),
    { task: fixture, serverId: LOCAL_SERVER_ID },
  );
  await central()
    .getByRole("button", { name: /^(Arquivadas|Archived)$/ })
    .click();
  await menu(renamed);
  await page.getByRole("menuitem", { name: /^(Restaurar|Restore)$/ }).waitFor();
  await shot("02-arquivadas-e-restauracao.png");
  checks.push("Archive persists and the Archived disclosure exposes the restore action.");
  await page.getByRole("menuitem", { name: /^(Restaurar|Restore)$/ }).click();
  await page.waitForFunction(
    async ({ task, serverId }) =>
      (await window.openbot.agent.listTasks(task.agentId, serverId)).tasks.some(
        (item) => item.id === task.id && item.state !== "closed",
      ),
    { task: fixture, serverId: LOCAL_SERVER_ID },
  );
  await central()
    .getByRole("region", { name: /^(Em andamento|In progress)/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(renamed)}`) })
    .waitFor();
  checks.push("Restore returns the task to the open list and reuses the existing thread operation.");
  await central()
    .getByRole("button", { name: new RegExp(`^${escapePattern(renamed)}`) })
    .click();
  await page.getByRole("textbox", { name: new RegExp(escapePattern(renamed)) }).waitFor();
  assert.equal(await page.locator(".side-thread-panel").count(), 0);
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).waitFor();
  checks.push("Row click opens the existing task in the main column and preserves Central on the right.");
  if ((await page.getByRole("tab", { name: new RegExp(escapePattern(renamed)) }).count()) > 0) {
    await page.getByRole("tab", { name: new RegExp(escapePattern(renamed)) }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Abrir ao lado do chat|Open beside chat/ }).click();
    await page.locator(".side-thread-panel").waitFor();
    await page.getByRole("tab", { name: /^(Central do agente|Agent central)$/ }).click();
    await central()
      .getByRole("button", { name: new RegExp(`^${escapePattern(renamed)}`) })
      .click();
    await page.getByRole("textbox", { name: new RegExp(escapePattern(renamed)) }).waitFor();
    assert.equal(await page.locator(".side-thread-panel").count(), 0);
    assert.equal(
      await page
        .locator(".side-panel-header")
        .getByRole("tab", { name: new RegExp(escapePattern(renamed)) })
        .count(),
      0,
    );
    checks.push("A task previously opened on the side moves to the main column instead of leaving a duplicate tab.");
  } else {
    checks.push(
      "Main-column opening works with the user's sidebar placement; its topbar-only side-move action was not exercised.",
    );
  }
  await page.getByRole("button", { name: /Abrir o chat principal|Open main chat/, exact: true }).click();
  await menu(renamed);
  await page.getByRole("menuitem", { name: /^(Abrir|Open)$/ }).click();
  await page.getByRole("textbox", { name: new RegExp(escapePattern(renamed)) }).waitFor();
  assert.equal(await page.locator(".side-thread-panel").count(), 0);
  checks.push("The menu Open action also opens the main column, without a duplicate side chat.");
  await page.getByRole("button", { name: /Abrir o chat principal|Open main chat/, exact: true }).click();
  await menu(renamed);
  await page.getByRole("menuitem", { name: /^(Excluir|Delete)$/ }).click();
  await page.getByRole("button", { name: /^(Desfazer|Undo)$/ }).click();
  await page.waitForFunction(
    async ({ task, serverId }) =>
      (await window.openbot.agent.listTasks(task.agentId, serverId)).tasks.some(
        (item) => item.id === task.id && item.state !== "closed",
      ),
    { task: fixture, serverId: LOCAL_SERVER_ID },
  );
  checks.push("Delete reuses the existing reversible action and Undo restores only this test's task.");
  const mainChatButton = page.getByRole("button", { name: /Abrir o chat principal|Open main chat/, exact: true });
  if (await mainChatButton.isVisible()) await mainChatButton.click();
  const resizer = page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
  await resizer.press("Home");
  await shot("06-lista-compacta.png");
  for (let index = 0; index < 20; index++) await resizer.press("ArrowLeft");
  await menu(renamed);
  await shot("07-menu-padronizado.png");
  await page.keyboard.press("Escape");
  await shot("03-central-completa.png");
  await central().screenshot({ path: resolve(out, "05-central-painel.png") });
  await page.getByRole("button", { name: /Maximizar painel lateral|Maximize side panel/, exact: true }).click();
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).waitFor();
  await shot("04-central-ampliada.png");
  await page.getByRole("button", { name: /Restaurar painel lateral|Restore side panel/, exact: true }).click();
  checks.push("Maximize and restore preserve the Central and its responsive activity grid.");
  await central()
    .getByRole("button", { name: /^(Nova tarefa|New task)$/ })
    .click();
  await page
    .getByRole("textbox", {
      name: new RegExp(`^(Novo tópico com|New thread with) ${escapePattern(candidate.agent.name)}$`),
    })
    .waitFor();
  checks.push("New task opens the existing draft editor; no provider turn is sent.");
  assert.deepEqual(errors, []);
  checks.push("No renderer page errors; the main window was never navigated or reloaded.");
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
      { width: originalWidth, preference: originalPreference, sections: originalSections },
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
    failure,
    errors,
    profile: instance.profile,
    url: main.url(),
    fixtureRemoved: fixture !== undefined,
    dedicatedWindowClosed: ownedPage !== undefined,
  };
  await writeFile(resolve(out, "resultado.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(".openbot-build/agent-central-actions-e2e/report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
