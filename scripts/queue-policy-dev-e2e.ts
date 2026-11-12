// Real named dev renderer, IPC, SQLite and native Codex adapter with a controlled local CLI.
// Start dev with the FAKE_TURN_INPUT_CODEX fixture and OPENBOT_FAKE_CODEX_CONTROL/LOG below.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BusyMessageModePreference } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assertMutationAllowed({
  command: "queue-policy-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const control = resolve(".openbot-build/queue-policy-dev/control.json");
const protocol = resolve(".openbot-build/queue-policy-dev/protocol.jsonl");
const out = resolve("specs/evidencias/fila-dez-topicos");
await mkdir(out, { recursive: true });
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("queue-policy-dev"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = session;
page.setDefaultTimeout(15_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks: string[] = [];
const report = {
  passed: false,
  checks,
  errors,
  providerCalls: 0,
  rendererUrl: page.url(),
  profile: instance.profile,
  error: "",
  fixtureRemoved: false,
  preferenceRestored: false,
};
let agentId: string | undefined;
let previous: string | null = null;
let protocolOffset = 0;
let preference: BusyMessageModePreference | undefined;
function fixtureId(): string {
  if (!agentId) throw new Error("The fixture agent has not been created.");
  return agentId;
}
const editor = () => page.getByRole("textbox", { name: /Mensagem para Evidência de fila/ });
const read = () => page.evaluate((id) => window.openbot.agent.readConversation(id), fixtureId());
const setMode = (mode: "queue" | "steer", own: "queue" | "steer" | null) =>
  page.evaluate(
    async ({ id, mode, own }) => {
      await window.openbot.setBusyMessageModePreference({ mode });
      await window.openbot.agent.updateAgentHostSettings({ agentId: id, busyMessageMode: own });
    },
    { id: fixtureId(), mode, own },
  );
const send = async (text: string) => {
  await editor().fill(text);
  await editor().press("Enter");
};
const held = async (label: string) => {
  await writeFile(control, JSON.stringify({ turnMs: 20, releaseAll: false }));
  await send(`HOLD-STEER ${label}`);
  await page.waitForFunction(
    async (id) => Boolean((await window.openbot.agent.readConversation(id)).activeTurnId),
    fixtureId(),
  );
  const snapshot = await read();
  assert(snapshot.activeTurnId);
  return snapshot.activeTurnId;
};
const queued = (text: string, taskId?: string) =>
  page.waitForFunction(
    async ({ id, text, taskId }) => {
      const queue = taskId
        ? (await window.openbot.agent.listTasks(id)).tasks.find((task) => task.id === taskId)?.queue
        : (await window.openbot.agent.listQueue(id)).deliveries;
      return queue?.some((entry) => entry.text === text && entry.status === "queued");
    },
    { id: fixtureId(), text, taskId },
  );
const settled = () =>
  page.waitForFunction(async (id) => {
    const c = await window.openbot.agent.readConversation(id);
    const queue = await window.openbot.agent.listQueue(id);
    return (
      !c.activeTurnId &&
      !queue.deliveries.some(
        (entry) => entry.status === "queued" || entry.status === "starting" || entry.status === "running",
      )
    );
  }, fixtureId());
const release = async () => {
  await writeFile(control, JSON.stringify({ turnMs: 20, releaseAll: true }));
};
const capture = async (name: string) => {
  const cdp = await session.browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getProcessInfo");
  await cdp.detach();
  const pid = info.processInfo.find((entry) => entry.type === "browser")?.id;
  assert(pid);
  execFileSync("/usr/bin/osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`,
  ]);
  const windows: { kCGWindowNumber: number }[] = JSON.parse(
    execFileSync(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("CoreGraphics");const ws=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0)));JSON.stringify(ws.filter(w=>w.kCGWindowOwnerPID===${pid}&&w.kCGWindowName==="OpenBot"&&w.kCGWindowIsOnscreen&&w.kCGWindowBounds.Width>800));`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert(windows[0]);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(windows[0].kCGWindowNumber), resolve(out, name)]);
};
try {
  await page.reload({ waitUntil: "domcontentloaded" });
  protocolOffset = (await readFile(protocol, "utf8")).split("\n").filter(Boolean).length;
  const status = await page.evaluate(async () =>
    (await window.openbot.agent.getStatus()).providers?.find((entry) => entry.id === "codex"),
  );
  assert.equal(status?.version, "99.0.0", "Only run with the controlled Codex CLI, never a paid provider.");
  previous = await page
    .locator(".agent-row[aria-pressed='true']")
    .evaluateAll((entries) => entries[0]?.getAttribute("aria-label") ?? null);
  preference = await page.evaluate(() => window.openbot.getBusyMessageModePreference());
  await page.evaluate(() => window.openbot.setBusyMessageModePreference({ mode: "queue" }));
  const agent = await page.evaluate(async () => {
    const model = (await window.openbot.agent.listModels()).find((entry) => entry.provider === "codex");
    if (!model) throw Error("No controlled Codex model");
    return window.openbot.agent.createAgent({
      name: "Evidência de fila",
      description: "Fixture temporária local.",
      provider: "codex",
      model: model.id,
      avatarSeed: "queue-policy",
      avatarHue: null,
      initialMessage: "Preparação.",
    });
  });
  agentId = agent.id;
  await page.waitForFunction(
    async (id) =>
      (await window.openbot.agent.readConversation(id)).messages.some(
        (m) => m.author === "assistant" && m.text === "Done." && m.status === "completed",
      ),
    agentId,
  );
  await settled();
  await page.locator(`[data-chat-id="${fixtureId()}"] > .agent-row`).click();
  const firstTurn = await held("original com app em Fila");
  await send("Mensagem seguinte um");
  await queued("Mensagem seguinte um");
  await send("Mensagem seguinte dois");
  await queued("Mensagem seguinte dois");
  assert.equal((await read()).activeTurnId, firstTurn);
  checks.push("Enter com Padrão do app (Fila) deixa duas mensagens aguardando o turno original.");
  await capture("01-fila-durante-turno.png");
  await release();
  await settled();
  await page.waitForFunction(
    async ({ id, firstTurn }) => {
      const snapshot = await window.openbot.agent.readConversation(id);
      return ["Mensagem seguinte um", "Mensagem seguinte dois"].every((text) =>
        snapshot.messages.some(
          (message) =>
            message.author === "user" && message.text === text && message.turnId && message.turnId !== firstTurn,
        ),
      );
    },
    { id: fixtureId(), firstTurn },
  );
  const history = await read();
  const following = ["Mensagem seguinte um", "Mensagem seguinte dois"].map((text) =>
    history.messages.find((message) => message.author === "user" && message.text === text),
  );
  assert(following.every((entry) => entry?.turnId && entry.turnId !== firstTurn));
  assert.notEqual(following[0]?.turnId, following[1]?.turnId);
  checks.push("As duas mensagens iniciam turnos distintos após o original, na mesma conversa.");
  await setMode("steer", "queue");
  await held("preferência do agente Fila");
  await send("Fila do agente prevalece");
  await queued("Fila do agente prevalece");
  await release();
  await settled();
  checks.push("Preferência Fila do agente prevalece sobre Orientação global.");
  await setMode("queue", "steer");
  const steeringTurn = await held("preferência do agente Orientação");
  await send("Orientação do agente prevalece");
  await page.waitForFunction(
    async ({ id, turnId }) =>
      (await window.openbot.agent.readConversation(id)).messages.some(
        (entry) =>
          entry.author === "user" && entry.text === "Orientação do agente prevalece" && entry.turnId === turnId,
      ),
    { id: agentId, turnId: steeringTurn },
  );
  await editor().fill("Fila explícita prevalece");
  await page.getByRole("button", { name: "Adicionar à instrução", exact: true }).click();
  await page.getByRole("menuitem", { name: "Enfileirar mensagem", exact: true }).click();
  await queued("Fila explícita prevalece");
  await release();
  await settled();
  checks.push("Orientação configurada alcança o turno atual; Enfileirar explícito continua aguardando.");
  await setMode("queue", null);
  const explicitTurn = await held("Orientação explícita");
  await editor().fill("FINISH-STEER orientação explícita");
  await editor().press("Tab");
  await settled();
  assert(
    (await read()).messages.some(
      (entry) =>
        entry.author === "user" && entry.text === "FINISH-STEER orientação explícita" && entry.turnId === explicitTurn,
    ),
  );
  checks.push("Tab/Orientar explícito prevalece sobre a Fila configurada.");
  await writeFile(control, JSON.stringify({ turnMs: 20, releaseAll: false }));
  const task = await page.evaluate(
    (id) => window.openbot.agent.startTask({ agentId: id, text: "HOLD-STEER tarefa lateral" }),
    agentId,
  );
  await page.getByRole("button", { name: "Todos os tópicos", exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${task.title}`) }).click();
  await send("Fila padrão na tarefa");
  await queued("Fila padrão na tarefa", task.id);
  await release();
  await page.waitForFunction(
    async ({ id, taskId }) => {
      const c = await window.openbot.agent.readTask({ agentId: id, taskId });
      return (
        !c.activeTurnId &&
        c.messages.some((m) => m.author === "user" && m.text === "Fila padrão na tarefa" && Boolean(m.turnId))
      );
    },
    { id: agentId, taskId: task.id },
  );
  assert(!(await read()).messages.some((entry) => entry.text === "Fila padrão na tarefa"));
  checks.push("Composer da tarefa usa a Fila padrão e mantém suas mensagens isoladas do principal.");
  await page.locator(`[data-chat-id="${fixtureId()}"] > .agent-row`).click();
  const openMain = page.getByRole("button", { name: "Abrir o chat principal", exact: true });
  if (await openMain.isVisible()) await openMain.click();
  await page.getByRole("button", { name: "Ver configurações do agente", exact: true }).click();
  await page.getByRole("button", { name: "Avançado", exact: true }).click();
  await page.getByText("Tópicos em paralelo", { exact: true }).click();
  await page.getByRole("option", { name: "10", exact: true }).waitFor();
  await capture("02-opcoes-ate-dez.png");
  await page.getByRole("option", { name: "10", exact: true }).click();
  await page.waitForFunction(
    async (id) => (await window.openbot.agent.listAgents()).find((a) => a.id === id)?.taskLimit === 10,
    agentId,
  );
  await capture("03-limite-dez-salvo.png");
  checks.push("Configurações oferecem 1–10 e salvam 10 pelo fluxo real da interface.");
  const lines = (await readFile(protocol, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(protocolOffset)
    .map((line) => JSON.parse(line));
  const starts = lines.filter((line) => line.method === "turn/start");
  const queueStarts = ["Mensagem seguinte um", "Mensagem seguinte dois"].map((text) =>
    starts.find((line) => JSON.stringify(line.params.input).includes(text)),
  );
  assert(queueStarts.every(Boolean));
  assert.equal(queueStarts[0].params.threadId, queueStarts[1].params.threadId);
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  await capture("falha.png").catch(() => {});
  await writeFile(resolve(out, "falha-ui.txt"), await page.locator("body").innerText()).catch(() => {});
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  throw error;
} finally {
  await release();
  const other = await page.evaluate(
    async (id) => (await window.openbot.agent.listAgents()).find((a) => a.id !== id)?.id,
    agentId,
  );
  if (other) await page.locator(`[data-chat-id="${other}"] > .agent-row`).click();
  if (agentId) {
    await page.evaluate(async (id) => {
      for (const task of (await window.openbot.agent.listTasks(id)).tasks) {
        await window.openbot.agent.stopTask({ agentId: id, taskId: task.id });
        await window.openbot.agent.closeTask({ agentId: id, taskId: task.id });
        await window.openbot.agent.deleteTask({ agentId: id, taskId: task.id });
      }
      await window.openbot.agent.deleteAgent(id);
    }, agentId);
    report.fixtureRemoved = await page.evaluate(
      async (id) => !(await window.openbot.agent.listAgents()).some((entry) => entry.id === id),
      agentId,
    );
  }
  if (preference) {
    await page.evaluate((value) => window.openbot.setBusyMessageModePreference(value), preference);
    report.preferenceRestored = true;
  }
  if (previous)
    await page
      .getByRole("button", { name: previous, exact: true })
      .click()
      .catch(() => {});
  await writeFile(resolve(out, "dev.json"), `${JSON.stringify(report, null, 2)}\n`);
  await session.close();
}
