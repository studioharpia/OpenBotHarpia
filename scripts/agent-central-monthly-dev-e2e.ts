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
  command: "agent-central-monthly-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-central-monthly-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(
  process.argv.find((arg) => arg.startsWith("--evidence-dir="))?.slice("--evidence-dir=".length) ??
    "specs/evidencias/central-do-agente/cards-mensais",
);
await mkdir(out, { recursive: true });
await mkdir(resolve(".openbot-build/agent-central-monthly-dev-e2e"), { recursive: true });
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
        { agentId: candidate.agent.id, taskId: task.id, title: "Evidência — métricas mensais" },
        serverId,
      );
      return { ...task, title: "Evidência — métricas mensais" };
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

  const cards = () => central().getByRole("definition");
  const periodControl = () => central().getByRole("button", { name: /Período de uso|Usage period/ });
  const expected = async (previous: boolean) =>
    page.evaluate(
      async ({ agentId, serverId, previous }) => {
        const now = new Date();
        const formatDate = (date: Date) =>
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const startDate = formatDate(new Date(now.getFullYear(), now.getMonth() - (previous ? 1 : 0), 1));
        const endDate = previous ? formatDate(new Date(now.getFullYear(), now.getMonth(), 0)) : formatDate(now);
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const report = await window.openbot.agent.getHostAnalytics({ agentId, startDate, endDate, timeZone }, serverId);
        return {
          startDate,
          endDate,
          tokens:
            report && (report.totals.processedTokens > 0 || report.totals.missingUsageTurns === 0)
              ? Math.max(0, report.totals.processedTokens - (report.totals.cachedInput ?? 0))
              : null,
          finished: report?.completedTasks ?? null,
        };
      },
      { agentId: candidate.agent.id, serverId: LOCAL_SERVER_ID, previous },
    );
  const verify = async (previous: boolean) => {
    const value = await expected(previous);
    await page.waitForFunction(
      () => document.querySelector(".agent-central-metrics")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await cards().count(), 3);
    // Assert data against real IPC, while screenshots supply visual evidence of the three cards.
    const tokens = cards().nth(1);
    const tokenText = await tokens.textContent();
    if (value.tokens === null) assert.equal(tokenText?.trim(), "–");
    else assert.equal(await tokens.getAttribute("title"), new Intl.NumberFormat("pt-BR").format(value.tokens));
    if (value.finished !== null) {
      await page.waitForFunction(
        (finished) =>
          document.querySelectorAll(".agent-central-metrics dd")[2]?.textContent?.trim() ===
          new Intl.NumberFormat("pt-BR").format(finished),
        value.finished,
      );
    }
    const monthLabel = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${value.startDate}T12:00:00Z`),
    );
    await central().getByRole("heading", { name: monthLabel, exact: true }).waitFor();
    return value;
  };
  await periodControl()
    .getByText(/Mês atual|This month/, { exact: true })
    .waitFor();
  const checkFullMonth = async (previous: boolean) => {
    const period = await expected(previous);
    const start = new Date(`${period.startDate}T12:00:00Z`);
    const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const count = last.getUTCDate();
    const cells = central()
      .getByRole("img", { name: /^(Atividade de tokens|Token activity)$/ })
      .locator(".profile-heat-cell");
    await cells.nth(count - 1).hover();
    const day = new Intl.DateTimeFormat("pt-BR", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(last);
    await page.locator(".profile-heat-tooltip").getByText(day, { exact: true }).waitFor();
    if (!previous && count > new Date().getDate())
      await page
        .locator(".profile-heat-tooltip")
        .getByText(/^(Indisponível|Unavailable)$/)
        .waitFor();
    if ((await cells.count()) > count) {
      await cells.nth(count).hover();
      await page.locator(".profile-heat-tooltip").waitFor({ state: "hidden" });
    }
    await central().getByRole("heading", { name: candidate.agent.name, exact: true }).hover();
    checks.push(
      `The chart reaches the actual final day of ${previous ? "previous" : "current"} month (${count} days); future dates and padding do not invent consumption.`,
    );
  };
  const current = await verify(false);
  await checkFullMonth(false);
  checks.push(
    "Three metrics show the current calendar month; totals match real host analytics, including persisted task completions.",
  );
  await page.locator(".settings-panel-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot("01-mes-atual.png");
  await periodControl().click();
  const previousOption = page.getByRole("option", { name: /Mês anterior|Last month/, exact: true });
  await previousOption.waitFor();
  assert.equal(await page.getByRole("option").count(), 2);
  await previousOption.click();
  const previous = await verify(true);
  await checkFullMonth(true);
  assert(previous.endDate < current.startDate);
  checks.push("The selector offers exactly current and previous month; previous month totals and dates match IPC.");
  await shot("02-mes-anterior.png");
  await periodControl().click();
  await page.getByRole("option", { name: /Mês atual|This month/, exact: true }).click();
  await verify(false);
  checks.push("Switching back to current month restores its own data without stale previous-month values.");
  const resizer = page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
  await resizer.press("Home");
  for (let index = 0; index < 20; index++) await resizer.press("ArrowLeft");
  await shot("04-painel-amplo.png");
  await shot("05-central-metricas.png");
  await resizer.press("Home");
  await checkFullMonth(false);
  await page.locator(".settings-panel-content").evaluate((element) => {
    element.scrollTop = 0;
  });
  await shot("03-painel-compacto.png");
  checks.push(
    "The compact dock keeps the same three metrics; screenshot records the month grid and Usage typography at minimum width.",
  );
  // An unstarted branch is not completed, even when archived.
  await central()
    .getByRole("button", { name: new RegExp(`^(Ações de|Actions for) ${escapePattern(fixture.title)}$`) })
    .click();
  await page.getByRole("menuitem", { name: /^(Arquivar|Archive)$/ }).click();
  await verify(false);
  checks.push("Archiving the test's unstarted task does not increase the finished-task metric.");
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
    resolve(".openbot-build/agent-central-monthly-dev-e2e/report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
