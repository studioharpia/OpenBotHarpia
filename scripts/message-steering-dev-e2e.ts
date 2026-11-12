// Real named dev app, IPC, SQLite, Pi CLI and local model endpoint; --codex uses one real Codex request and follow-up. Installed app is preserved.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev wt-"));
assertMutationAllowed({
  command: "message-steering-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("message-steering-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const { page } = connection;
page.setDefaultTimeout(30_000);
const out = resolve("specs/evidencias/mensagens-durante-execucao/dev");
await mkdir(out, { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const providerId = "steering-local-e2e";
const useCodex = process.argv.includes("--codex");
const ids: string[] = [];
let gate: ServerResponse | undefined;
let resume: ServerResponse | undefined;
let gateOpened: (() => void) | undefined;
let resumeOpened: (() => void) | undefined;
const gateReady = new Promise<void>((done) => {
  gateOpened = done;
});
const resumeReady = new Promise<void>((done) => {
  resumeOpened = done;
});
let requestCount = 0;
let phase = 0;
let modelPort = 0;
let originalSelection: string | undefined;
let savedProvider = false;
const deliveryMeasurements: { durationMs: number }[] = [];
interface CompletionDelta {
  role?: string;
  content?: string;
  tool_calls?: { index: number; id: string; type: string; function: { name: string; arguments: string } }[];
}
const report = {
  passed: false,
  checks,
  rendererErrors: errors,
  provider: useCodex ? "Codex real" : "Pi real com endpoint local controlado",
  profile: instance.profile,
  rendererUrl: page.url(),
  error: "",
  modelRequests: 0,
  deliveryMeasurements,
};
const server = createServer(async (request, response) => {
  if (request.url === "/gate") {
    gate = response;
    gateOpened?.();
    return;
  }
  if (request.url === "/resume") {
    resume = response;
    resumeOpened?.();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requestCount++;
    const user = (body.messages ?? []).filter((message: { role: string }) => message.role === "user").at(-1);
    const last = JSON.stringify(user?.content ?? "");
    let content = "Preparação concluída.";
    let tool: string | undefined;
    if (phase === 0 && last.includes("HOLD-STEER")) {
      phase = 1;
      content = "Vou conferir as referências, preservando os arquivos e o contexto.";
      tool = "gate";
    } else if (phase === 1) {
      assert(last.includes("excluindo"), "The steering message did not reach the real Pi model request.");
      phase = 2;
      content = "Somente conferência. Nenhuma skill foi excluída. Vou continuar a tarefa original.";
      tool = "resume";
    } else if (phase === 2) {
      phase = 3;
      content = "Verificação original concluída. O contexto e os arquivos foram preservados.";
    } else if (phase >= 3) content = "Demanda enfileirada recebida depois da verificação original.";
    if (tool)
      assert(
        body.tools?.some((item: { function?: { name?: string } }) => item.function?.name === "bash"),
        "Pi did not expose its native bash tool.",
      );
    const toolCalls = tool
      ? [
          {
            index: 0,
            id: `call-${tool}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: `curl --fail --silent http://127.0.0.1:${modelPort}/${tool}`,
                timeout: 60,
              }),
            },
          },
        ]
      : undefined;
    const event = (delta: CompletionDelta, finish: string | null) =>
      `data: ${JSON.stringify({ id: `chatcmpl-evidence-${requestCount}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "check", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(event({ role: "assistant", content }, null));
    if (toolCalls) response.write(event({ tool_calls: toolCalls }, null));
    response.write(event({}, tool ? "tool_calls" : "stop"));
    response.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Local evidence endpoint refused the request." } }));
  }
});

try {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object");
  modelPort = address.port;
  originalSelection =
    (await page
      .locator("[data-chat-id]:has(> .agent-row[aria-pressed='true'])")
      .first()
      .getAttribute("data-chat-id")
      .catch(() => null)) ?? undefined;
  if (!useCodex) {
    await page.evaluate(
      async ({ providerId, modelPort }) => {
        await window.openbot.customProviders.save({
          id: providerId,
          name: "Evidência local de orientação",
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          apiKey: "local-evidence-only",
          models: [{ id: "check", name: "Local check", contextWindow: 262_144, maxOutput: 4096 }],
          headers: [],
          harness: "pi",
        });
      },
      { providerId, modelPort },
    );
    savedProvider = true;
    await page.waitForFunction(async () => {
      const provider = (await window.openbot.agent.getStatus()).providers?.find((provider) => provider.id === "pi");
      return provider?.state === "available" && !provider.restartPending && provider.connectionState !== "connecting";
    });
    await page.waitForFunction(
      async (providerId) =>
        (await window.openbot.agent.listModels()).some((model) => model.id === `${providerId}/check`),
      providerId,
    );
    const modelState = await page.evaluate(
      async (providerId) => ({
        models: (await window.openbot.agent.listModels())
          .filter((model) => model.id.includes(providerId))
          .map((model) => ({ id: model.id, provider: model.provider })),
        provider: (await window.openbot.agent.getStatus()).providers?.find((provider) => provider.id === "pi"),
        endpoint: (await window.openbot.customProviders.list())
          .filter((provider) => provider.id === providerId)
          .map((provider) => ({ id: provider.id, harness: provider.harness })),
      }),
      providerId,
    );
    await writeFile(resolve(out, "ambiente.json"), `${JSON.stringify(modelState, null, 2)}\n`);
  }
  const owner = await page.evaluate(
    async ({ providerId, useCodex }) =>
      window.openbot.agent.createAgent({
        name: "Evidência — orientação",
        avatarSeed: "steering-evidence",
        avatarHue: null,
        description: "Fixture temporária, modelo local controlado.",
        provider: useCodex ? "codex" : "pi",
        model: useCodex ? "gpt-6.1-sol" : `${providerId}/check`,
        initialMessage: useCodex ? "Responda apenas: Preparação concluída." : "Preparar teste local.",
      }),
    { providerId, useCodex },
  );
  ids.push(owner.id);
  // This harness exercises configured steering; queue is covered by queue-policy-dev-e2e.
  await page.evaluate(
    (agentId) => window.openbot.agent.updateAgentHostSettings({ agentId, busyMessageMode: "steer" }),
    owner.id,
  );
  const other = await page.evaluate(
    async ({ providerId, useCodex, ownerId }) => {
      const existing = (await window.openbot.agent.listAgents()).find((agent) => agent.id !== ownerId);
      if (existing) return { id: existing.id, created: false };
      const agent = await window.openbot.agent.createAgent({
        name: "Evidência — navegação",
        avatarSeed: "steering-other",
        avatarHue: null,
        description: "Fixture temporária.",
        provider: useCodex ? "codex" : "pi",
        model: useCodex ? "gpt-6.1-sol" : `${providerId}/check`,
        initialMessage: "Responda apenas: Preparação concluída.",
      });
      return { id: agent.id, created: true };
    },
    { providerId, useCodex, ownerId: owner.id },
  );
  if (other.created) ids.push(other.id);
  await page.waitForFunction(
    async (id) =>
      !(await window.openbot.agent.readConversation(id)).activeTurnId &&
      (await window.openbot.agent.readConversation(id)).messages.some((m) => m.text.includes("Preparação concluída")),
    owner.id,
  );
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  const row = (id: string) => page.locator(`[data-chat-id="${id}"] > .agent-row`);
  await row(owner.id).click();
  const editor = page.getByRole("textbox", { name: "Mensagem para Evidência — orientação", exact: true });
  await editor.fill(
    useCodex
      ? `Teste controlado sem alterar arquivos. Responda com uma linha dizendo que está conferindo referências. Execute uma ferramenta de shell com curl --fail --silent http://127.0.0.1:${modelPort}/gate e aguarde terminar. Depois responda à orientação mais recente, se existir, e execute curl --fail --silent http://127.0.0.1:${modelPort}/resume. Quando terminar, escreva exatamente: Verificação original concluída. O contexto e os arquivos foram preservados. Não finalize antes desses dois comandos. Não leia skills ou outros arquivos para esse teste.`
      : "HOLD-STEER: conferir referências sem excluir arquivos.",
  );
  await editor.press("Enter");
  await Promise.race([
    gateReady,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Pi did not enter the controlled tool.")), 30_000),
    ),
  ]);
  const before = await page.evaluate(async (id) => window.openbot.agent.readConversation(id), owner.id);
  assert(before.activeTurnId);
  await page.screenshot({ path: resolve(out, "antes-da-pergunta.png") });
  const questionText = useCodex
    ? "Você está excluindo as skills? Responda exatamente: Somente conferência. Nenhuma skill foi excluída. Vou continuar a tarefa original. Depois continue o comando /resume da tarefa original."
    : "Você está excluindo as skills?";
  await editor.fill(questionText);
  await editor.press("Enter");
  await row(other.id).click();
  await page.waitForFunction(async (id) => {
    const snapshot = await window.openbot.agent.readConversation(id);
    return snapshot.messages.some(
      (message) =>
        message.author === "user" && message.text.includes("excluindo") && message.turnId === snapshot.activeTurnId,
    );
  }, owner.id);
  gate?.end("Primeira ferramenta concluída sem alterar arquivos.");
  gate = undefined;
  await Promise.race([
    resumeReady,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Pi did not continue the original task after the clarification.")), 30_000),
    ),
  ]);
  await row(owner.id).click();
  const question = page.getByText(questionText, { exact: true });
  const answer = page.getByText("Somente conferência. Nenhuma skill foi excluída. Vou continuar a tarefa original.", {
    exact: true,
  });
  await answer.waitFor();
  const positions = await Promise.all([question.boundingBox(), answer.boundingBox()]);
  await writeFile(
    resolve(out, "posicoes.json"),
    JSON.stringify({ question: positions[0], answer: positions[1] }, null, 2),
  );
  const during = await page.evaluate(async (id) => window.openbot.agent.readConversation(id), owner.id);
  assert.equal(during.activeTurnId, before.activeTurnId);
  assert.equal(during.threadId, before.threadId);
  checks.push(
    "Enter steers the real provider turn, survives navigation to another agent, and retains the original thread/turn/history.",
  );
  checks.push("The actual dev UI shows the clarification below the question during the ongoing task.");
  await page.screenshot({ path: resolve(out, "resposta-abaixo-da-pergunta.png") });
  await editor.fill(
    useCodex
      ? "Outra demanda para depois da execução. Quando chegar a vez dela, responda exatamente: Demanda enfileirada recebida depois da verificação original."
      : "Outra demanda para depois da execução.",
  );
  await page.getByRole("button", { name: "Adicionar à instrução", exact: true }).click();
  await page.getByRole("menuitem", { name: "Enfileirar mensagem", exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.openbot.agent.listQueue(id)).deliveries.some(
        (d) => d.text.includes("Outra demanda") && d.status === "queued",
      ),
    owner.id,
  );
  assert.equal(
    (await page.evaluate(async (id) => window.openbot.agent.readConversation(id), owner.id)).activeTurnId,
    before.activeTurnId,
  );
  checks.push("Explicit queue waits without changing or interrupting the current turn.");
  await page.screenshot({ path: resolve(out, "enfileiramento-explicito.png") });
  resume?.end("Verificação concluída.");
  resume = undefined;
  await page
    .getByRole("main", { name: "Conversa", exact: true })
    .getByText("Demanda enfileirada recebida depois da verificação original.", { exact: true })
    .waitFor();
  await page.waitForFunction(async (id) => !(await window.openbot.agent.readConversation(id)).activeTurnId, owner.id);
  const after = await page.evaluate(async (id) => window.openbot.agent.readConversation(id), owner.id);
  assert(after.messages.some((m) => m.text.includes(useCodex ? "Teste controlado" : "HOLD-STEER")));
  assert(after.messages.some((m) => m.text.includes("Verificação original concluída")));
  assert(after.messages.some((m) => m.text.includes("Outra demanda")));
  checks.push("The original task finishes before the explicitly queued demand; both remain in history.");
  report.deliveryMeasurements = await page.evaluate(() =>
    performance.getEntriesByName("openbot.message.persisted").map((entry) => ({
      durationMs: entry.duration,
    })),
  );
  report.passed = errors.length === 0;
} catch (error) {
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  await page.screenshot({ path: resolve(out, "falha.png") }).catch(() => {});
} finally {
  gate?.end("cleanup");
  resume?.end("cleanup");
  for (const id of ids) {
    await page
      .evaluate(async (id) => {
        const snapshot = await window.openbot.agent.readConversation(id);
        if (snapshot.activeTurnId) await window.openbot.agent.interrupt({ agentId: id, turnId: snapshot.activeTurnId });
        await window.openbot.agent.deleteAgent(id);
      }, id)
      .catch((error: Error) => {
        report.error += ` Cleanup: ${error.message}`;
        report.passed = false;
      });
  }
  if (savedProvider)
    await page
      .evaluate(async (id) => window.openbot.customProviders.delete({ id }), providerId)
      .catch((error: Error) => {
        report.error += ` Cleanup: ${error.message}`;
        report.passed = false;
      });
  if (originalSelection)
    await page
      .locator(`[data-chat-id="${originalSelection}"] > .agent-row`)
      .click()
      .catch(() => {});
  report.modelRequests = requestCount;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await writeFile(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await connection.close();
  if (!report.passed) process.exitCode = 1;
  // Machine-readable: local E2E report.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
