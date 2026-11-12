// Real dev queue, local ACP/MCP, prompt, plan and instruction notice. No external provider or OS mouse.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const named = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === named && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "queue-message-order-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  ...(named === undefined ? {} : { target: named }),
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("queue-message-order-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(".openbot-build/ordem-mensagens-fila");
const evidence = resolve("specs/evidencias/ordem-mensagens-fila");
await mkdir(out, { recursive: true });
await mkdir(evidence, { recursive: true });
const providerId = `queue-order-${Date.now()}`;
const checks: string[] = [];
const errors: string[] = [];
let agentId: string | undefined;
let page: Page | undefined;
const report: {
  passed: boolean;
  url: string;
  profile: string;
  checks: string[];
  errors: string[];
  failure: string;
  stored: { id: string; time: string; type?: string }[];
  displayed: string[];
} = {
  passed: false,
  url: `http://localhost:${instance.rendererPort}`,
  profile: instance.profile,
  checks,
  errors,
  failure: "",
  stored: [],
  displayed: [],
};
const sections = await main.evaluate(() => localStorage.getItem("openbot:central-task-sections"));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 25_000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Timed out waiting for queue fixture state");
    await delay(50);
  }
}
try {
  const fake = resolve(out, "provider.ts");
  await writeFile(
    fake,
    `import { serveFakeAcpAgent } from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};
import { appendFile } from "node:fs/promises";
const sessions=new Map();let n=0;let rpc=0;
async function tool(server,name,args){const id=++rpc;const response=await fetch(server.url,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:"tool_call",arguments:{name,arguments:args}}})});const body=await response.text();const packets=body.startsWith("data:")||body.includes("\\ndata:")?body.split("\\n").filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5))):[JSON.parse(body)];const packet=packets.find(p=>p.id===id);if(!response.ok||!packet||packet.error||packet.result?.isError)throw Error("Local tool failed");}
serveFakeAcpAgent({
 initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"queue-order-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),
 "session/new":(r,p)=>{const id="queue-order-"+(++n);sessions.set(id,{server:r.params.mcpServers?.find(s=>s.name==="openbot"),cwd:r.params.cwd});p.reply(r,{sessionId:id,models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}})},
 "session/load":(r,p)=>p.reply(r,{models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),
 "session/prompt":async(r,p)=>{try{const text=r.params.prompt?.filter(c=>c.type==="text").map(c=>c.text).join("\\n")??"";const session=sessions.get(r.params.sessionId);
 if(text.includes("long-term memory")){p.say(r.params.sessionId,'{"operations":[]}');}
 else if(text.includes("EXECUCAO_A")){await tool(session.server,"openbot.ask_user",{questions:[{id:"start",question:"Autoriza iniciar a conferência local?",options:[{label:"Começar"}]}]});p.update(r.params.sessionId,{sessionUpdate:"plan",entries:[{content:"Conferir tipografia e organização da página",priority:"high",status:"completed"}]});await appendFile(session.cwd+"/AGENTS.md","\\nEvidência temporária de encerramento do primeiro turno.\\n");p.say(r.params.sessionId,"Primeira execução concluída; a próxima estava na fila.");}
 else if(text.includes("EXECUCAO_B")){while(!(await Bun.file(${JSON.stringify(resolve(out, "control.json"))}).json()).releaseB)await new Promise(done=>setTimeout(done,30));await tool(session.server,"openbot.attach_files_to_response",{paths:[session.cwd+"/pagina.png"]});p.say(r.params.sessionId,"Segunda execução concluída, depois do aviso de instruções.");}
 else p.say(r.params.sessionId,"Preparação concluída.");p.reply(r,{stopReason:"end_turn"});}catch(e){p.say(r.params.sessionId,"FIXTURE_FAILED: "+e.message);p.reply(r,{stopReason:"end_turn"});}}
});`,
  );
  await writeFile(resolve(out, "control.json"), JSON.stringify({ releaseB: false }));
  await main.evaluate(
    async ({ id, fake, command }) => {
      await window.openbot.customAgents.save({
        id,
        name: "Queue order fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      });
      await window.openbot.refreshAgentProviders({ automatic: false });
    },
    { id: providerId, fake, command: process.execPath },
  );
  await until(() =>
    main.evaluate(
      async (id) => (await window.openbot.agent.listModels()).some((model) => model.id === `${id}/default`),
      providerId,
    ),
  );
  const agent = await main.evaluate(
    (id) =>
      window.openbot.agent.createAgent(
        {
          name: "Evidência — ordem da fila",
          description: "Conferência temporária da cronologia",
          avatarSeed: "queue-order",
          avatarHue: null,
          initialMessage: "Preparar teste local.",
          provider: "acp",
          model: `${id}/default`,
        },
        "local",
      ),
    providerId,
  );
  agentId = agent.id;
  const read = () => main.evaluate((id) => window.openbot.agent.readConversation(id, "local"), agent.id);
  await until(async () => {
    const history = await read();
    return !history.activeTurnId && history.messages.some((message) => message.author === "assistant");
  });
  const bytes = await main.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 600;
    const context = canvas.getContext("2d");
    if (!context) throw Error("Missing canvas");
    context.fillStyle = "#be642b";
    context.fillRect(0, 0, 300, 600);
    context.fillStyle = "white";
    context.font = "28px sans-serif";
    context.fillText("Página revisada", 35, 260);
    return Array.from(Uint8Array.from(atob(canvas.toDataURL().split(",")[1] ?? ""), (c) => c.charCodeAt(0)));
  });
  await writeFile(resolve(agent.workspacePath, "pagina.png"), new Uint8Array(bytes));
  const opening = main.context().waitForEvent("page");
  await main.evaluate((id) => window.openbot.openChatWindow({ agentId: id, serverId: "local" }), agent.id);
  page = await opening;
  const owned = page;
  await owned.waitForURL((url) => url.searchParams.get("agent") === agent.id);
  owned.setDefaultTimeout(15_000);
  owned.on("pageerror", (error) => errors.push(error.message));
  await owned.setViewportSize({ width: 1250, height: 1050 });
  await owned.locator(".side-panel-toggle").waitFor();
  const click = async (selector: string) =>
    owned.locator(selector).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  if ((await owned.locator(".side-panel-toggle").getAttribute("aria-expanded")) === "true")
    await click(".side-panel-toggle");
  await main.evaluate(
    (id) =>
      window.openbot.agent.sendMessage({
        agentId: id,
        text: "EXECUCAO_A — Conferir a página.",
        deliveryMode: "queue",
        clientMessageId: crypto.randomUUID(),
      }),
    agent.id,
  );
  await until(async () => (await read()).messages.some((message) => message.questionPrompt?.resolution === null));
  await main.evaluate(
    (id) =>
      window.openbot.agent.sendMessage({
        agentId: id,
        text: "EXECUCAO_B — Revisar o resultado depois da primeira execução.",
        deliveryMode: "queue",
        clientMessageId: crypto.randomUUID(),
      }),
    agent.id,
  );
  await until(() =>
    main.evaluate(
      async (id) =>
        (await window.openbot.agent.listQueue(id)).deliveries.some(
          (delivery) => delivery.status === "queued" && delivery.text.includes("EXECUCAO_B"),
        ),
      agent.id,
    ),
  );
  checks.push("Segunda mensagem realmente ficou na fila enquanto a primeira aguardava a resposta à pergunta.");
  const question = (await read()).messages.find((message) => message.questionPrompt?.resolution === null);
  assert(question?.questionPrompt);
  await main.evaluate((input) => window.openbot.agent.respondToPrompt(input), {
    requestId: question.questionPrompt.requestId,
    answers: { start: ["Começar"] },
  });
  await until(async () =>
    (await read()).messages.some(
      (message) => message.itemType === "agent_instructions_change" || message.id.endsWith(":instructions-change"),
    ),
  );
  await writeFile(resolve(out, "control.json"), JSON.stringify({ releaseB: true }));
  await until(async () => {
    const history = await read();
    return (
      !history.activeTurnId &&
      history.messages.some(
        (message) =>
          message.author === "assistant" &&
          (message.text.includes("Segunda execução concluída") || message.text.includes("FIXTURE_FAILED")),
      )
    );
  });
  const history = await read();
  assert(!history.messages.some((message) => message.text.includes("FIXTURE_FAILED")));
  const plan = history.messages.find((message) => message.itemType === "plan");
  const notice = history.messages.find((message) => message.id.endsWith(":instructions-change"));
  const image = history.messages.find((message) => message.attachments?.some((file) => file.name === "pagina.png"));
  assert(plan);
  assert(notice);
  assert(image);
  assert(Date.parse(question.createdAt) < Date.parse(plan.createdAt));
  assert(Date.parse(notice.createdAt) < Date.parse(image.createdAt));
  assert(history.messages.indexOf(plan) < history.messages.findIndex((message) => message.id === question.id));
  assert(history.messages.indexOf(image) < history.messages.indexOf(notice));
  report.stored = history.messages.map((message) => ({
    id: message.id,
    time: message.createdAt,
    ...(message.itemType === undefined ? {} : { type: message.itemType }),
  }));
  checks.push(
    "Reproduzidas as duas inversões no histórico por turnos: plano antes da pergunta mais antiga; imagem do turno seguinte antes do aviso anterior.",
  );
  const display = async () =>
    owned
      .locator("[data-chat-search-message]")
      .evaluateAll((elements) => [
        ...new Set(elements.map((element) => element.getAttribute("data-chat-search-message") ?? "").filter(Boolean)),
      ]);
  await until(async () => {
    const ids = await display();
    return ids.includes(image.id) && ids.includes(notice.id) && ids.includes(question.id) && ids.includes(plan.id);
  });
  report.displayed = await display();
  const byId = new Map(history.messages.map((message) => [message.id, message]));
  const shown = report.displayed.flatMap((id) => byId.get(id) ?? []);
  assert(shown.length >= 6);
  assert(
    shown.every(
      (message, index) => index === 0 || Date.parse(message.createdAt) >= Date.parse(shown[index - 1]?.createdAt ?? ""),
    ),
  );
  assert(report.displayed.indexOf(question.id) < report.displayed.indexOf(plan.id));
  assert(report.displayed.indexOf(notice.id) < report.displayed.indexOf(image.id));
  checks.push(
    "Chat integrado exibiu as mensagens em ordem cronológica, incluindo pergunta, plano, aviso e imagem, com os mesmos IDs e horários armazenados.",
  );
  await owned.locator("[data-sonner-toast] button[aria-label]").evaluateAll((elements) => {
    for (const element of elements)
      if (
        element instanceof HTMLElement &&
        /Fechar notificação|Close toast/.test(element.getAttribute("aria-label") ?? "")
      )
        element.click();
  });
  const cdp = await owned.context().newCDPSession(owned);
  const capture = async (name: string) => {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: metrics.layoutViewport.clientWidth,
        height: metrics.layoutViewport.clientHeight,
        scale: 1,
      },
    });
    await writeFile(resolve(evidence, name), Buffer.from(result.data, "base64"));
  };
  await capture("01-chat.png");
  await main.evaluate(
    ({ id, throughMessageId }) => window.openbot.agent.markConversationRead({ agentId: id, throughMessageId }, "local"),
    { id: agent.id, throughMessageId: history.messages.at(-1)?.id ?? null },
  );
  assert.equal((await read()).readState?.unreadCount, 0);
  await main.evaluate(
    ({ id, fromMessageId }) => window.openbot.agent.markConversationUnread({ agentId: id, fromMessageId }, "local"),
    { id: agent.id, fromMessageId: image.id },
  );
  const unread = (await read()).readState;
  assert(unread && unread.unreadCount > 0);
  const lastAnswer = history.messages.findLast(
    (message) => message.author === "assistant" && message.text.includes("Segunda execução concluída"),
  );
  assert(lastAnswer);
  await main.evaluate((input) => window.openbot.agent.branchTask(input, "local"), {
    agentId: agent.id,
    taskId: null,
    messageId: lastAnswer.id,
    requestId: crypto.randomUUID(),
  });
  await click(".side-panel-toggle");
  const launch = owned.getByRole("button", { name: /Abrir Central do agente|Open agent central/i });
  if (await launch.count())
    await launch.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  const central = owned.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  await central.getByRole("heading", { name: agent.name, exact: true }).waitFor();
  for (const label of [/^(Concluídas|Completed)$/, /^(Em andamento|In progress)$/]) {
    const section = central.getByRole("button", { name: label });
    if ((await section.getAttribute("aria-expanded")) === "false")
      await section.evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
  }
  await central
    .locator(".agent-central-task-list .agent-central-task-main")
    .first()
    .evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  await owned.getByRole("button", { name: "Visualizar pagina.png", exact: true }).waitFor();
  await click(".side-panel-toggle");
  const taskIds = await display();
  assert(taskIds.indexOf(question.id) >= 0 && taskIds.indexOf(question.id) < taskIds.indexOf(plan.id));
  await capture("02-tarefa.png");
  assert.deepEqual((await read()).readState, unread);
  assert.deepEqual(
    (await read()).messages.map((message) => [message.id, message.createdAt]),
    history.messages.map((message) => [message.id, message.createdAt]),
  );
  checks.push(
    "Tarefa ramificada também mostrou pergunta antes do plano; marcar lida/não lida e navegar à tarefa preservou cursor, histórico e horários da conversa principal.",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: resolve(out, "falha.png") }).catch(() => {});
    await writeFile(resolve(out, "falha.html"), await page.content()).catch(() => {});
  }
} finally {
  if (page && !page.isClosed()) await page.close();
  await writeFile(resolve(out, "control.json"), JSON.stringify({ releaseB: true }));
  await main
    .evaluate(
      async ({ id, providerId }) => {
        if (id) {
          const history = await window.openbot.agent.readConversation(id);
          if (history.activeTurnId) await window.openbot.agent.interrupt({ agentId: id, turnId: history.activeTurnId });
          await window.openbot.agent.deleteAgent(id);
        }
        await window.openbot.customAgents.delete({ id: providerId });
      },
      { id: agentId, providerId },
    )
    .catch((error: Error) => {
      report.failure += ` Cleanup: ${error.message}`;
      report.passed = false;
      process.exitCode = 1;
    });
  await main.evaluate((value) => {
    if (value === null) localStorage.removeItem("openbot:central-task-sections");
    else localStorage.setItem("openbot:central-task-sections", value);
  }, sections);
  await connection.close();
  await writeFile(resolve(evidence, "resultado.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
