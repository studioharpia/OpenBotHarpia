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
  command: "agent-central-sections-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-central-sections-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(
  process.argv.find((argument) => argument.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente/cabecalho-e-secoes",
);
await mkdir(out, { recursive: true });
await mkdir(resolve(".openbot-build/agent-central-sections-dev-e2e"), { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
let ownedPage: Page | undefined;
let fixture: AgentTask | undefined;
let archivedFixture: AgentTask | undefined;
let otherPage: Page | undefined;
let originalSections: string | null = null;
let originalWidth: string | null = null;
let originalPreference: string | null = null;
let passed = false;
let failure = "";
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
try {
  const candidate = await main.evaluate(async (serverId) => {
    const windows = await window.openbot.getChatWindows();
    const agents = await window.openbot.agent.listAgents(serverId);
    const candidates = [];
    for (const agent of agents) {
      if (windows.some((item) => item.serverId === serverId && item.agentId === agent.id)) continue;
      const conversation = await window.openbot.agent.readConversation(agent.id, serverId);
      if (conversation.activeTurnId) continue;
      const answer = conversation.messages.findLast(
        (message) => message.author === "assistant" && message.status === "completed" && !message.itemType,
      );
      if (!answer) continue;
      const snapshot = await window.openbot.agent.listTasks(agent.id, serverId);
      const completed = snapshot.tasks.filter((task) => task.outcome === "completed" && task.state === "idle").length;
      candidates.push({ agent, answerId: answer.id, completed });
    }
    candidates.sort((a, b) => b.completed - a.completed);
    return candidates[0] && candidates[1] ? { ...candidates[0], other: candidates[1].agent } : null;
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
        { agentId: candidate.agent.id, taskId: task.id, title: "Evidência — tarefa aberta nas seções" },
        serverId,
      );
      return { ...task, title: "Evidência — tarefa aberta nas seções" };
    },
    { candidate, serverId: LOCAL_SERVER_ID },
  );
  archivedFixture = await main.evaluate(
    async ({ candidate, serverId }) => {
      const task = await window.openbot.agent.branchTask(
        { agentId: candidate.agent.id, taskId: null, messageId: candidate.answerId, requestId: crypto.randomUUID() },
        serverId,
      );
      await window.openbot.agent.renameTask(
        { agentId: task.agentId, taskId: task.id, title: "Evidência — tarefa arquivada nas seções" },
        serverId,
      );
      await window.openbot.agent.closeTask({ agentId: task.agentId, taskId: task.id }, serverId);
      return { ...task, title: "Evidência — tarefa arquivada nas seções" };
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
  await page.setViewportSize({ width: 1400, height: 1180 });
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
  await central().getByRole("status").waitFor();
  const heading = (target: Page, label: RegExp) =>
    target
      .getByRole("complementary", { name: /^(Central do agente|Agent central)$/ })
      .getByRole("button", { name: label, exact: true });
  const completedLabel = /^(Concluídas|Completed)$/;
  const activeLabel = /^(Em andamento|In progress)$/;
  const archivedLabel = /^(Arquivadas|Archived)$/;
  const waitExpanded = async (target: Page, label: RegExp, expanded: boolean) => {
    const element = await heading(target, label).elementHandle();
    await target.waitForFunction(({ element, expected }) => element?.getAttribute("aria-expanded") === expected, {
      element,
      expected: expanded ? "true" : "false",
    });
  };
  const expand = async (target: Page, label: RegExp) => {
    if ((await heading(target, label).getAttribute("aria-expanded")) === "false") await heading(target, label).click();
    await waitExpanded(target, label, true);
  };
  // Exercise fresh-device defaults temporarily; finally restores the exact original preference.
  await page.evaluate(() => {
    localStorage.removeItem("openbot:central-task-sections");
    window.dispatchEvent(new StorageEvent("storage", { key: "openbot:central-task-sections", newValue: null }));
  });
  await waitExpanded(page, archivedLabel, false);
  await waitExpanded(page, completedLabel, true);
  await waitExpanded(page, activeLabel, true);
  checks.push(
    "Fresh-device defaults expand Completed/In progress and collapse Archived; the original preference is restored after the test.",
  );
  await expand(page, completedLabel);
  await expand(page, activeLabel);
  const sourceTasks = (
    await page.evaluate(({ agentId, serverId }) => window.openbot.agent.listTasks(agentId, serverId), {
      agentId: candidate.agent.id,
      serverId: LOCAL_SERVER_ID,
    })
  ).tasks;
  let positiveCompleted = 0;
  for (const task of sourceTasks) {
    if (task.state === "closed") continue;
    const finished = task.outcome === "completed" && task.state === "idle";
    if (finished) positiveCompleted++;
    const section = central().getByRole("region", {
      name: finished ? /^(Concluídas|Completed)/ : /^(Em andamento|In progress)/,
    });
    await section.getByRole("button", { name: new RegExp(`^${escapePattern(task.title)}`) }).waitFor();
  }
  checks.push(
    `Completed and In progress match real task state; ${positiveCompleted} existing completed tasks were read without modification.`,
  );
  await expand(page, archivedLabel);
  await central()
    .getByRole("region", { name: /^(Arquivadas|Archived)/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(archivedFixture.title)}`) })
    .waitFor();
  checks.push("Archived contains the test's archived task, independently of its last outcome.");
  await heading(page, activeLabel).focus();
  await heading(page, activeLabel).press("Space");
  await waitExpanded(page, activeLabel, false);
  assert.equal(
    JSON.parse((await page.evaluate(() => localStorage.getItem("openbot:central-task-sections"))) ?? "null").active,
    true,
  );
  checks.push("Keyboard collapse saves the section preference to the device.");
  const openedB = main.context().waitForEvent("page");
  await main.evaluate((target) => window.openbot.openChatWindow(target), {
    agentId: candidate.other.id,
    serverId: LOCAL_SERVER_ID,
  });
  const second = await openedB;
  second.setDefaultTimeout(15000);
  second.on("pageerror", (error) => errors.push(error.message));
  await second.waitForURL(
    (url) =>
      url.searchParams.get("window") === "chat" &&
      url.searchParams.get("server") === LOCAL_SERVER_ID &&
      url.searchParams.get("agent") === candidate.other.id,
  );
  otherPage = second;
  await second.locator(".side-panel-toggle").waitFor();
  if ((await second.locator(".side-panel-toggle").getAttribute("aria-expanded")) === "false")
    await second.locator(".side-panel-toggle").click();
  const secondTab = second.getByRole("tab", { name: /^(Central do agente|Agent central)$/ });
  if (await secondTab.count()) await secondTab.click();
  else {
    await second.getByRole("button", { name: /^(Adicionar painel|Add pane)$/ }).click();
    await second.getByRole("menuitem", { name: /^(Central do agente|Agent central)$/ }).click();
  }
  await waitExpanded(second, activeLabel, false);
  checks.push("Another agent's newly opened window inherits the saved collapse preference.");
  await heading(second, completedLabel).focus();
  await heading(second, completedLabel).press("Enter");
  await waitExpanded(second, completedLabel, false);
  await waitExpanded(page, completedLabel, false);
  checks.push("A change in another agent window synchronizes immediately back to the first window.");
  await second.reload();
  await second
    .getByRole("complementary", { name: /^(Central do agente|Agent central)$/ })
    .getByRole("heading", { name: candidate.other.name, exact: true })
    .waitFor();
  await waitExpanded(second, completedLabel, false);
  await waitExpanded(second, activeLabel, false);
  checks.push("Reload restores both completed and in-progress preferences from persistent storage.");
  await expand(page, completedLabel);
  await expand(page, activeLabel);
  await heading(page, archivedLabel).click();
  await waitExpanded(second, archivedLabel, false);
  const resizer = page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
  await resizer.press("Home");
  for (let index = 0; index < 20; index++) await resizer.press("ArrowLeft");
  await page.locator(".settings-panel-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot("01-central-ampla.png");
  await shot("02-central-cabecalho-e-secoes.png");
  await resizer.press("Home");
  await page.locator(".settings-panel-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot("03-central-compacta.png");
  checks.push(
    "Screenshots record the larger identity, real status, responsive header and aligned task sections at both dock widths.",
  );
  await central()
    .getByRole("region", { name: /^(Em andamento|In progress)/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(fixture.title)}`) })
    .click();
  await page.getByRole("textbox", { name: new RegExp(escapePattern(fixture.title)) }).waitFor();
  assert.equal(await page.locator(".side-thread-panel").count(), 0);
  checks.push("The grouped row still opens its real task in the main column, preserving Central on the right.");
  await page.locator(".settings-panel-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).hover();
  await shot("04-sem-hover-selecionada.png");
  await heading(page, completedLabel).hover();
  await shot("05-hover-secao.png");
  await heading(page, completedLabel).click();
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).hover();
  await shot("06-colapsada-sem-hover.png");
  await heading(page, completedLabel).click();
  await central()
    .getByRole("region", { name: /^(Em andamento|In progress)/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(fixture.title)}`) })
    .hover();
  await shot("07-hover-tarefa.png");

  await expand(page, archivedLabel);
  await central()
    .getByRole("region", { name: /^(Arquivadas|Archived)/ })
    .getByRole("button", { name: new RegExp(`^(Ações de|Actions for) ${escapePattern(archivedFixture.title)}$`) })
    .click();
  await page.getByRole("menuitem", { name: /^(Restaurar|Restore)$/ }).click();
  await central()
    .getByRole("region", { name: /^(Em andamento|In progress)/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(archivedFixture.title)}`) })
    .waitFor();
  checks.push(
    "Restoring the test's archived task moves it back into In progress without changing disclosure preferences.",
  );
  await central()
    .getByRole("button", { name: /^(Configurações do agente|Agent settings)$/ })
    .click();
  await page.getByRole("tab", { name: /^(Configurações do agente|Agent settings)$/ }).waitFor();
  await page.getByRole("tab", { name: /^(Central do agente|Agent central)$/ }).click();
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).waitFor();
  checks.push("The standard settings button retains its existing navigation.");
  assert.deepEqual(errors, []);
  checks.push("No renderer errors or provider turns; only temporary test tasks were mutated.");
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
    if (otherPage && !otherPage.isClosed()) await otherPage.close();
    await ownedPage.close();
  }
  for (const cleanupTask of [fixture, archivedFixture])
    if (cleanupTask)
      await main.evaluate(
        async ({ task, serverId }) => {
          await window.openbot.agent.closeTask({ agentId: task.agentId, taskId: task.id }, serverId);
          await window.openbot.agent.deleteTask({ agentId: task.agentId, taskId: task.id }, serverId);
        },
        { task: cleanupTask, serverId: LOCAL_SERVER_ID },
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
    otherWindowClosed: otherPage !== undefined,
    limitations: ["Manual behavior was validated on desktop; the web client was typechecked only."],
  };
  await writeFile(resolve(out, "resultado.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    resolve(".openbot-build/agent-central-sections-dev-e2e/report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
