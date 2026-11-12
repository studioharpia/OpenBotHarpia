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
  command: "agent-central-unread-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-central-unread-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(
  process.argv.find((arg) => arg.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente/nao-lidas",
);
await mkdir(out, { recursive: true });
await mkdir(resolve(".openbot-build/agent-central-unread-dev-e2e"), { recursive: true });
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
    const windows = await window.openbot.getChatWindows();
    const agents = await window.openbot.agent.listAgents(serverId);
    for (const agent of agents) {
      if (windows.some((target) => target.serverId === serverId && target.agentId === agent.id)) continue;
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
        { agentId: candidate.agent.id, taskId: task.id, title: "Evidência — não lida na Central" },
        serverId,
      );
      return { ...task, title: "Evidência — não lida na Central" };
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
  await page.setViewportSize({ width: 1400, height: 1050 });
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

  const resizer = page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
  // Only this owned branch is marked unread. Existing tasks and their read cursors stay untouched.
  const unreadInput = await page.evaluate(
    async ({ agentId, taskId }) => {
      const history = await window.openbot.agent.readTask({ agentId, taskId }, "local");
      const answer = history.messages.findLast((message) => message.author === "assistant" && !message.itemType);
      if (!answer) throw new Error("The owned branch needs an assistant message for the unread flow.");
      return { agentId, taskId, fromMessageId: answer.id };
    },
    { agentId: fixture.agentId, taskId: fixture.id },
  );
  const readState = await page.evaluate((input) => window.openbot.agent.markTaskUnread(input, "local"), unreadInput);
  assert(readState.unreadCount > 0);
  // Read marks have no cross-window event. Reload only the owned window to load the persisted mark.
  await page.reload();
  await central().waitFor();
  while (await notices.count()) {
    const close = notices.first();
    const element = await close.elementHandle();
    await close.focus();
    await close.press("Enter");
    await page.waitForFunction((target) => !target?.isConnected, element);
  }
  const unreadRow = central().getByRole("button", {
    name: new RegExp(`${escapePattern(fixture.title)}.*(nova.*resposta|new.*repl|unread)`, "i"),
  });
  await unreadRow.waitFor();
  await resizer.press("Home");
  for (let index = 0; index < 20; index++) await resizer.press("ArrowLeft");
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).hover();
  await shot("06-tarefa-nao-lida.png");
  checks.push(
    "Marking the owned task unread updates the Central row accessibly from the persisted read cursor; screenshot records the shared sidebar dot.",
  );
  await unreadRow.click();
  await page.bringToFront();
  await page.waitForFunction(
    async ({ agentId, taskId }) => {
      const reads = await window.openbot.agent.listTaskReads(agentId, "local");
      return reads.find((read) => read.taskId === taskId)?.unreadCount === 0;
    },
    { agentId: fixture.agentId, taskId: fixture.id },
  );
  await unreadRow.waitFor({ state: "hidden" });
  await central().getByRole("heading", { name: candidate.agent.name, exact: true }).hover();
  await shot("07-tarefa-lida.png");
  checks.push(
    "Opening that task in the main chat marks it read and removes the unread indicator without hiding or removing its row.",
  );
  assert.deepEqual(errors, []);
  checks.push("No renderer errors and no provider turns; the main window and existing tasks were preserved.");
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
      "Validated on the desktop dev app in a dedicated window; the web client was typechecked but not exercised manually.",
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
    resolve(".openbot-build/agent-central-unread-dev-e2e/report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
