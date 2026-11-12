// Real dev UI, owned fixtures and background window. DOM pointer events never move the OS cursor.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTask, ClientAgentSummary } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import type { Locator, Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const id = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === id && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "agent-task-transfer-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(id),
  target: id,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-task-transfer-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve("specs/evidencias/transferencia-tarefas");
await mkdir(out, { recursive: true });
const selectedAgents: ClientAgentSummary[] = [];
let fixture: AgentTask | undefined;
let page: Page | undefined;
let placement: string | null = null;
let panelWidth: string | null = null;
const checks: string[] = [];
const errors: string[] = [];
let passed = false;
let failure = "";
try {
  placement = await main.evaluate(() => localStorage.getItem("openbot:thread-placement"));
  panelWidth = await main.evaluate(() => localStorage.getItem("openbot:side-panel-width"));
  const candidate = await main.evaluate(async () => {
    const windows = await window.openbot.getChatWindows();
    const agents = (await window.openbot.agent.listAgents("local")).filter(
      (agent) => !windows.some((entry) => entry.serverId === "local" && entry.agentId === agent.id),
    );
    for (const agent of agents) {
      const history = await window.openbot.agent.readConversation(agent.id, "local");
      if (history.activeTurnId) continue;
      const answer = history.messages.findLast(
        (message) => message.author === "assistant" && message.status === "completed" && !message.itemType,
      );
      if (answer) {
        for (const other of agents) {
          if (other.id === agent.id) continue;
          if (!(await window.openbot.agent.readConversation(other.id, "local")).activeTurnId)
            return { agentId: agent.id, messageId: answer.id, a: agent, b: other };
        }
      }
    }
    return null;
  });
  assert(candidate);
  const { a, b } = candidate;
  selectedAgents.push(a, b);
  fixture = await main.evaluate(
    async ({ candidate, a }) => {
      const task = await window.openbot.agent.branchTask(
        { agentId: candidate.agentId, taskId: null, messageId: candidate.messageId, requestId: crypto.randomUUID() },
        "local",
      );
      await window.openbot.agent.renameTask(
        { agentId: candidate.agentId, taskId: task.id, title: "Revisar proposta de lançamento" },
        "local",
      );
      return { ...task, agentId: a.id, title: "Revisar proposta de lançamento" };
    },
    { candidate, a },
  );
  const opened = main.context().waitForEvent("page");
  await main.evaluate((agentId) => window.openbot.openChatWindow({ agentId, serverId: "local" }), a.id);
  const owned = await opened;
  await owned.waitForURL((url) => url.searchParams.get("window") === "chat" && url.searchParams.get("agent") === a.id);
  page = owned;
  owned.on("pageerror", (error) => errors.push(error.message));
  owned.setDefaultTimeout(12_000);
  // The same trusted dev origin in our owned window exposes the full workspace/sidebar.
  await owned.evaluate(() => localStorage.setItem("openbot:side-panel-width", "650"));
  await owned.goto(`http://localhost:${instance.rendererPort}/`);
  const session = await owned.context().newCDPSession(owned);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 2000,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await owned.locator(".app-loading").waitFor({ state: "hidden" });
  const domClick = async (locator: Locator) => {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  };
  const closeNotices = async () => {
    await owned.locator("[data-sonner-toast] button[aria-label]").evaluateAll((elements) => {
      for (const element of elements)
        if (
          element instanceof HTMLElement &&
          /Fechar notificação|Close toast/.test(element.getAttribute("aria-label") ?? "")
        )
          element.click();
    });
  };
  const agent = (agentId: string) => owned.locator(`[data-task-transfer-agent="${agentId}"]`);
  await agent(a.id).waitFor();
  await closeNotices();
  await domClick(agent(a.id));
  const central = () => owned.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  const toggle = owned.locator(".side-panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await domClick(toggle);
  const tab = owned.getByRole("tab", { name: /^(Central do agente|Agent central)$/ });
  if (await tab.count()) await domClick(tab);
  else {
    const launch = owned.getByRole("button", { name: /^(Abrir Central do agente|Open Agent central)$/ });
    if (await launch.isVisible()) await domClick(launch);
    else {
      await domClick(owned.getByRole("button", { name: /^(Adicionar painel|Add pane)$/ }));
      await domClick(owned.getByRole("menuitem", { name: /^(Central do agente|Agent central)$/ }));
    }
  }
  await central().getByRole("heading", { name: a.name, exact: true }).waitFor();
  const task = fixture;
  const unread = await owned.evaluate(
    async ({ agentId, taskId }) => {
      const history = await window.openbot.agent.readTask({ agentId, taskId }, "local");
      const answer = history.messages.findLast((message) => message.author === "assistant" && !message.itemType);
      if (!answer) throw new Error("Expected own branch history");
      return window.openbot.agent.markTaskUnread({ agentId, taskId, fromMessageId: answer.id }, "local");
    },
    { agentId: a.id, taskId: task.id },
  );
  const before = await owned.evaluate((input) => window.openbot.agent.readTask(input, "local"), {
    agentId: a.id,
    taskId: task.id,
  });
  const centralRow = () => central().locator(".agent-central-task-main").filter({ hasText: task.title });
  const drag = async (source: Locator, target: Locator, shot?: string, cancel = false) => {
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const order = await owned.evaluate(() => window.openbot.agent.getSidebarLayout("local"));
    const start = await source.boundingBox();
    const end = await target.boundingBox();
    assert(start && end);
    const coordinates = {
      x: start.x + start.width / 2,
      y: start.y + start.height / 2,
      tx: end.x + end.width / 2,
      ty: end.y + end.height / 2,
    };
    await source.evaluate((element, point) => {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 741,
          isPrimary: true,
          button: 0,
          buttons: 1,
          pointerType: "mouse",
          clientX: point.x,
          clientY: point.y,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 741,
          isPrimary: true,
          buttons: 1,
          pointerType: "mouse",
          clientX: point.tx,
          clientY: point.ty,
        }),
      );
    }, coordinates);
    await target.count(); // protocol boundary, without a timer or OS input
    if (shot) {
      const refused = await agent(a.id).evaluate((element) => {
        const event = new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert(refused, "Agent ordering must refuse native drag during a task transfer");
      await owned.locator(".task-transfer-drag-preview").waitFor();
      await owned.screenshot({ path: resolve(out, shot), fullPage: true });
    }
    await owned.evaluate(
      ({ tx, ty, cancel }) => {
        if (cancel) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        window.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId: 741,
            isPrimary: true,
            button: 0,
            buttons: 0,
            pointerType: "mouse",
            clientX: tx,
            clientY: ty,
          }),
        );
      },
      { ...coordinates, cancel },
    );
    assert.deepEqual(
      await owned.evaluate(() => window.openbot.agent.getSidebarLayout("local")),
      order,
      "Dragging a task never reorders agents",
    );
  };
  const assertUnread = async (agentId: string, stage: string) => {
    const read = (
      await owned.evaluate((agentId) => window.openbot.agent.listTaskReads(agentId, "local"), agentId)
    ).find((entry) => entry.taskId === task.id);
    assert.equal(read?.unreadCount, unread.unreadCount, stage);
  };
  const waitOwner = async (agentId: string) => {
    await owned.waitForFunction(
      async ({ agentId, taskId }) =>
        (await window.openbot.agent.listTasks(agentId, "local")).tasks.some((item) => item.id === taskId),
      { agentId, taskId: task.id },
    );
  };
  await centralRow().waitFor();
  await drag(centralRow(), agent(b.id), "01-arraste-central.png");
  await waitOwner(b.id);
  await domClick(agent(b.id));
  await centralRow().waitFor();
  const readsAfter = await owned.evaluate((agentId) => window.openbot.agent.listTaskReads(agentId, "local"), b.id);
  assert.equal(readsAfter.find((read) => read.taskId === task.id)?.unreadCount, unread.unreadCount);
  await centralRow().locator(".agent-threads-unread").waitFor();
  await owned.screenshot({ path: resolve(out, "02-destino-nao-lida.png"), fullPage: true });
  checks.push(
    "Central → outro agente: mesma tarefa e não lidas preservadas; destino não abre automaticamente o chat da tarefa.",
  );
  // Open a tab without activating the conversation, so this test preserves its unread cursor.
  await owned.evaluate(
    ({ agentId, taskId }) => {
      const key = "openbot:thread-tabs:v1";
      const all = JSON.parse(localStorage.getItem(key) ?? "{}");
      all.local ??= {};
      const tabs = all.local[agentId] ?? { open: [], side: [], active: null };
      all.local[agentId] = { ...tabs, open: [...tabs.open.filter((id: string) => id !== taskId), taskId] };
      localStorage.setItem("openbot:thread-placement", "topbar");
      const value = JSON.stringify(all);
      localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
    },
    { agentId: b.id, taskId: task.id },
  );
  await owned.reload();
  await agent(b.id).waitFor();
  await domClick(agent(b.id));
  await closeNotices();
  const topbar = owned.locator(`.agent-threads-tabs .agent-threads-tab[data-thread-id="${task.id}"]`);
  await topbar.waitFor();
  await assertUnread(b.id, "before topbar drag");
  await drag(topbar, agent(a.id), undefined, true);
  assert(
    (await owned.evaluate((agentId) => window.openbot.agent.listTasks(agentId, "local"), b.id)).tasks.some(
      (item) => item.id === task.id,
    ),
  );
  await assertUnread(b.id, "after cancelled topbar");
  checks.push("Escape cancela o arraste da topbar sem transferir ou abrir a tarefa.");
  await drag(topbar, agent(a.id), "03-arraste-topbar.png");
  await waitOwner(a.id);
  await assertUnread(a.id, "after topbar transfer");
  checks.push("Topbar → outro agente: transferência efetiva pela aba existente.");
  await domClick(agent(a.id));
  await owned.evaluate(() => {
    const key = "openbot:thread-placement";
    localStorage.setItem(key, "sidebar");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "sidebar" }));
  });
  const sidebarRow = owned
    .locator(".sidebar-agent-thread-button")
    .filter({ hasText: task.title })
    .filter({ hasNot: owned.locator(".agent-central-task-main") })
    .first();
  await sidebarRow.waitFor();
  await assertUnread(a.id, "before sidebar transfer");
  await drag(sidebarRow, agent(b.id), "04-arraste-lateral.png");
  await waitOwner(b.id);
  const after = await owned.evaluate((input) => window.openbot.agent.readTask(input, "local"), {
    agentId: b.id,
    taskId: task.id,
  });
  assert.equal(after.threadId, before.threadId);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(
    (await owned.evaluate((agentId) => window.openbot.agent.listTaskReads(agentId, "local"), b.id)).find(
      (read) => read.taskId === task.id,
    )?.unreadCount,
    unread.unreadCount,
  );
  checks.push(
    "Barra lateral → outro agente: histórico completo, threadId e não lidas idênticos após as três transferências.",
  );
  assert.deepEqual(errors, []);
  await owned.evaluate(() => localStorage.setItem("openbot:thread-placement", "topbar"));
  await owned.reload();
  await agent(b.id).waitFor();
  await domClick(agent(b.id));
  await closeNotices();
  await domClick(owned.locator(`.agent-threads-tabs .agent-threads-tab[data-thread-id="${task.id}"]`));
  await owned.waitForFunction(
    async ({ agentId, taskId }) =>
      (await window.openbot.agent.listTaskReads(agentId, "local")).find((read) => read.taskId === taskId)
        ?.unreadCount === 0,
    { agentId: b.id, taskId: task.id },
  );
  checks.push("Clique normal na aba continua abrindo a tarefa e marcando suas mensagens como lidas.");
  checks.push(
    "Durante o arraste, origem oculta, preview único e ordenação de agentes bloqueada; Escape restaura a origem.",
  );
  checks.push(
    "Eventos DOM sintéticos em janela exclusiva do dev, sem mover o mouse, chamar focus/bringToFront na janela ou iniciar turno de IA.",
  );
  passed = true;
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(out, "falha.png") }).catch(() => undefined);
} finally {
  if (page && !page.isClosed()) await page.close();
  // Remove only our agent keys; never overwrite another window's complete preferences.
  await main.evaluate(
    ({ ids, placement, panelWidth, taskId }) => {
      const key = "openbot:thread-tabs:v1";
      const all = JSON.parse(localStorage.getItem(key) ?? "{}");
      for (const agentId of ids) {
        const tabs = all.local?.[agentId];
        if (tabs && taskId) {
          tabs.open = tabs.open.filter((id: string) => id !== taskId);
          tabs.side = tabs.side.filter((id: string) => id !== taskId);
          if (tabs.active === taskId) tabs.active = null;
        }
      }
      localStorage.setItem(key, JSON.stringify(all));
      if (localStorage.getItem("openbot:side-panel-width") === "650") {
        if (panelWidth === null) localStorage.removeItem("openbot:side-panel-width");
        else localStorage.setItem("openbot:side-panel-width", panelWidth);
      }
      if (placement === null) localStorage.removeItem("openbot:thread-placement");
      else localStorage.setItem("openbot:thread-placement", placement);
      window.dispatchEvent(new StorageEvent("storage", { key: "openbot:thread-placement", newValue: placement }));
    },
    { ids: selectedAgents.map((agent) => agent.id), placement, panelWidth, taskId: fixture?.id },
  );
  if (fixture)
    await main.evaluate(
      async ({ ids, taskId }) => {
        for (const agentId of ids)
          if ((await window.openbot.agent.listTasks(agentId, "local")).tasks.some((task) => task.id === taskId)) {
            await window.openbot.agent.deleteTask({ agentId, taskId }, "local");
            break;
          }
      },
      { ids: selectedAgents.map((agent) => agent.id), taskId: fixture.id },
    );
  const report = {
    passed,
    checks,
    errors,
    failure,
    profile: instance.profile,
    url: main.url(),
    version: "main local sem commit",
    input: "Eventos DOM, sem mouse do sistema ou chamadas de ativação de janela",
    fixturesRemoved: true,
    productionReinstalled: false,
  };
  await writeFile(resolve(out, "dev-resultado.json"), `${JSON.stringify(report, null, 2)}\n`);
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
