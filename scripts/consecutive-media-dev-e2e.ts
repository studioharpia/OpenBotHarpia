// Real dev IPC, local MCP attachment tool and native chat window; no external provider or OS mouse.
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
  command: "consecutive-media-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  target: named,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("consecutive-media-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const originalSections = await main.evaluate(() => localStorage.getItem("openbot:central-task-sections"));
const output = resolve(".openbot-build/midias-consecutivas");
const evidence = resolve("specs/evidencias/midias-consecutivas");
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const providerId = `media-e2e-${Date.now()}`;
const checks: string[] = [];
const errors: string[] = [];
let agentId: string | undefined;
let page: Page | undefined;
const report: {
  passed: boolean;
  profile: string;
  url: string;
  checks: string[];
  errors: string[];
  failure: string;
  stage: string;
  virtualized?: boolean;
  messages: { id: string; turnId?: string; files: string[] }[];
} = {
  passed: false,
  profile: instance.profile,
  url: `http://localhost:${instance.rendererPort}`,
  checks,
  errors,
  failure: "",
  stage: "setup",
  messages: [],
};
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 25_000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Timed out waiting for fixture state");
    await delay(50);
  }
}
try {
  const fake = resolve(output, "provider.ts");
  await writeFile(
    fake,
    `import { serveFakeAcpAgent } from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};
const servers=new Map();let n=0;let rpc=0;
async function call(server,paths){
 const response=await fetch(server.url,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream",...Object.fromEntries(server.headers.map(h=>[h.name,h.value]))},body:JSON.stringify({jsonrpc:"2.0",id:++rpc,method:"tools/call",params:{name:"tool_call",arguments:{name:"openbot.attach_files_to_response",arguments:{paths}}}})});
 const body=await response.text();const packets=body.startsWith("data:")||body.includes("\\ndata:")?body.split("\\n").filter(l=>l.startsWith("data:")).map(l=>JSON.parse(l.slice(5))):[JSON.parse(body)];
 const packet=packets.find(p=>p.id===rpc);if(!response.ok||!packet||packet.error||packet.result?.isError)throw Error("Local attachment call failed: "+JSON.stringify(packet?.error??packet?.result));
}
serveFakeAcpAgent({
 initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"media-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),
 "session/new":(r,p)=>{const id="media-"+(++n);servers.set(id,r.params.mcpServers?.find(s=>s.name==="openbot"));p.reply(r,{sessionId:id,models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}})},
 "session/load":(r,p)=>p.reply(r,{models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),
 "session/prompt":async(r,p)=>{try{const text=r.params.prompt?.filter(c=>c.type==="text").map(c=>c.text).join("\\n")??"";const marker=text.lastIndexOf("MEDIA_FIXTURE:");if(marker>=0){const paths=await Bun.file(${JSON.stringify(resolve(output, "paths.json"))}).json();const server=servers.get(r.params.sessionId);if(!server)throw Error("No local tool server");for(const path of paths)await call(server,[path]);p.say(r.params.sessionId,"Imagens enviadas separadamente. Texto encerra a sequência.");}else p.say(r.params.sessionId,text.includes("long-term memory")?'{"operations":[]}':"Preparação concluída.");p.reply(r,{stopReason:"end_turn"});}catch(e){p.say(r.params.sessionId,"FIXTURE_FAILED: "+e.message);p.reply(r,{stopReason:"end_turn"});}}
});`,
  );
  await main.evaluate(
    async ({ id, fake, command }) => {
      await window.openbot.customAgents.save({
        id,
        name: "Media fixture",
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
          name: "Evidência — mídias consecutivas",
          description: "Teste temporário local",
          avatarSeed: "media",
          avatarHue: null,
          initialMessage: "Preparar conferência.",
          provider: "acp",
          model: `${id}/default`,
        },
        "local",
      ),
    providerId,
  );
  agentId = agent.id;
  await until(() =>
    main.evaluate(async (id) => {
      const history = await window.openbot.agent.readConversation(id);
      return !history.activeTurnId && history.messages.some((m) => m.author === "assistant");
    }, agent.id),
  );
  const images = await main.evaluate(() =>
    ["#a24a20", "#276c7a", "#6253a8", "#537b35"].map((color, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 300;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Missing canvas");
      context.fillStyle = color;
      context.fillRect(0, 0, 300, 900);
      context.fillStyle = "white";
      context.font = "60px sans-serif";
      context.fillText(`${index + 1}`, 110, 400);
      return {
        name: `evidencia-${index + 1}.png`,
        bytes: Array.from(Uint8Array.from(atob(canvas.toDataURL().split(",")[1] ?? ""), (c) => c.charCodeAt(0))),
      };
    }),
  );
  const paths: string[] = [];
  for (const image of images) {
    const path = resolve(agent.workspacePath, image.name);
    await writeFile(path, new Uint8Array(image.bytes));
    paths.push(path);
  }
  await writeFile(resolve(output, "paths.json"), JSON.stringify(paths));
  const opening = main.context().waitForEvent("page");
  await main.evaluate((id) => window.openbot.openChatWindow({ agentId: id, serverId: "local" }), agentId);
  page = await opening;
  await page.waitForURL((url) => url.searchParams.get("agent") === agentId);
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1250, height: 950 });
  await page.locator(".side-panel-toggle").waitFor();
  if ((await page.locator(".side-panel-toggle").getAttribute("aria-expanded")) === "true")
    await page.locator(".side-panel-toggle").evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  await main.evaluate(
    async ({ id }) =>
      window.openbot.agent.sendMessage({
        agentId: id,
        text: "MEDIA_FIXTURE: Envie as quatro imagens para conferência.",
        clientMessageId: crypto.randomUUID(),
      }),
    { id: agentId },
  );
  await until(() =>
    main.evaluate(async (id) => {
      const history = await window.openbot.agent.readConversation(id);
      return (
        !history.activeTurnId &&
        history.messages.some(
          (m) =>
            m.author === "assistant" &&
            (m.text.includes("Imagens enviadas separadamente") || m.text.includes("FIXTURE_FAILED")),
        )
      );
    }, agent.id),
  );
  const history = await main.evaluate((id) => window.openbot.agent.readConversation(id), agentId);
  await writeFile(resolve(output, "history.json"), JSON.stringify(history, null, 2));
  assert(
    !history.messages.some((message) => message.text.includes("FIXTURE_FAILED")),
    history.messages.find((m) => m.text.includes("FIXTURE_FAILED"))?.text,
  );
  const media = history.messages.filter((message) => message.author === "assistant" && message.attachments?.length);
  assert.equal(media.length, 4, "Four distinct messages must be stored");
  assert.equal(new Set(media.map((message) => message.id)).size, 4);
  assert.equal(new Set(media.map((message) => message.turnId)).size, 1);
  report.messages = media.map((message) => ({
    id: message.id,
    turnId: message.turnId,
    files: message.attachments?.map((file) => file.name) ?? [],
  }));
  checks.push(
    "Quatro chamadas reais ao attach_files_to_response geraram quatro mensagens distintas, no mesmo turno, com anexos preservados.",
  );
  await page.getByRole("button", { name: "Visualizar evidencia-4.png", exact: true }).waitFor();
  await page.locator("[data-sonner-toast] button[aria-label]").evaluateAll((elements) => {
    for (const element of elements)
      if (
        element instanceof HTMLElement &&
        /Fechar notificação|Close toast/.test(element.getAttribute("aria-label") ?? "")
      )
        element.click();
  });
  const cdp = await page.context().newCDPSession(page);
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
  for (const name of ["evidencia-2.png", "evidencia-4.png"]) {
    await page.getByRole("button", { name: `Visualizar ${name}`, exact: true }).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
    await page.locator(".image-lightbox").getByRole("img", { name, exact: true }).waitFor();
    assert(
      await page
        .locator(".image-lightbox")
        .getByRole("button", { name: `Baixar ${name}`, exact: true })
        .isEnabled(),
    );
    if (name === "evidencia-2.png") await capture("02-visualizador.png");
    await page.getByRole("button", { name: "Fechar visualizador de imagens", exact: true }).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
    await page.locator(".image-lightbox").waitFor({ state: "hidden" });
  }
  checks.push(
    "Clique na segunda e na quarta imagem abriu o arquivo correto no visualizador real; download permaneceu disponível.",
  );
  const branch = await main.evaluate((input) => window.openbot.agent.branchTask(input, "local"), {
    agentId,
    taskId: null,
    messageId: history.messages.at(-1)?.id ?? "",
    requestId: crypto.randomUUID(),
  });
  assert.equal(branch.agentId, agent.id);
  await page.locator(".side-panel-toggle").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  const central = page.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  const launchCentral = page.getByRole("button", { name: /Abrir Central do agente|Open agent central/i });
  if (await launchCentral.count())
    await launchCentral.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
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
  await page.getByRole("button", { name: "Visualizar evidencia-4.png", exact: true }).waitFor();
  await page.locator(".side-panel-toggle").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await capture("03-tarefa.png");
  checks.push(
    "A tarefa ramificada preservou os quatro anexos e abriu na coluna principal com o mesmo renderizador de tarefas.",
  );
  await page.getByRole("button", { name: "Visualizar evidencia-3.png", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.locator(".image-lightbox").getByRole("img", { name: "evidencia-3.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "Fechar visualizador de imagens", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.locator(".side-panel-toggle").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await central.locator(".agent-central-avatar-button").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.locator(".side-panel-toggle").evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  for (let index = 0; index < 52; index++) {
    report.stage = `long-turn-${index + 1}`;
    const clientMessageId = crypto.randomUUID();
    await main.evaluate(
      ({ id, clientMessageId, index }) =>
        window.openbot.agent.sendMessage({ agentId: id, text: `Conferência local ${index + 1}.`, clientMessageId }),
      { id: agent.id, clientMessageId, index },
    );
    await until(() =>
      main.evaluate(
        async ({ id, index }) => {
          const chat = await window.openbot.agent.readConversation(id);
          const user = chat.messages.find(
            (message) => message.author === "user" && message.text === `Conferência local ${index + 1}.`,
          );
          return (
            !chat.activeTurnId &&
            Boolean(user) &&
            chat.messages.some(
              (message) =>
                message.author === "assistant" && message.turnId === user?.turnId && message.status === "completed",
            )
          );
        },
        { id: agent.id, index },
      ),
    );
  }
  report.stage = "load-older";
  await until(async () => {
    await page?.locator(".conversation-scroll").evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page?.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
    return (
      Boolean(await page?.getByRole("button", { name: "Visualizar evidencia-4.png", exact: true }).isVisible()) &&
      (await page?.locator(".conversation-scroll").evaluate((element) => element.scrollTop)) === 0
    );
  });
  await page.getByRole("button", { name: "Visualizar evidencia-4.png", exact: true }).waitFor();
  report.stage = "delete-first";
  report.virtualized = await page
    .locator(".virtual-chat-list")
    .evaluate((element) => !element.classList.contains("virtual-chat-list-static"));
  await capture("04-historico-longo.png");
  const first = media[0];
  assert(first);
  const firstRow = page.locator(`[data-chat-search-message="${first.id}"]`);
  await firstRow
    .getByRole("button", { name: /Mais ações|More actions|Mais opções/ })
    .evaluate((element) =>
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })),
    );
  await page
    .getByRole("menuitem", { name: /^(Excluir|Delete)$/ })
    .evaluate((element) =>
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
    );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(Excluir|Delete)$/ })
    .evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  await until(() =>
    main.evaluate(
      async ({ id, messageId }) =>
        !(await window.openbot.agent.readConversation(id)).messages.some((message) => message.id === messageId),
      { id: agent.id, messageId: first.id },
    ),
  );
  await page.getByRole("button", { name: "Visualizar evidencia-1.png", exact: true }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Visualizar evidencia-2.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "Visualizar evidencia-2.png", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.locator(".image-lightbox").getByRole("img", { name: "evidencia-2.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "Fechar visualizador de imagens", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.locator(".image-lightbox").waitFor({ state: "hidden" });
  await capture("05-apos-excluir-primeira.png");
  checks.push(
    "Histórico com mais de 100 mensagens: carregamento de páginas antigas e exclusão da primeira imagem preservaram a segunda, seu ID e a abertura no visualizador.",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  if (agentId)
    await writeFile(
      resolve(output, "failed-history.json"),
      JSON.stringify(await main.evaluate((id) => window.openbot.agent.readConversation(id), agentId), null, 2),
    );
  if (page) await writeFile(resolve(output, "falha.html"), await page.content()).catch(() => {});
  if (page) await page.screenshot({ path: resolve(output, "falha.png") }).catch(() => {});
} finally {
  if (page && !page.isClosed()) await page.close();
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
  }, originalSections);
  await connection.close();
  await writeFile(resolve(evidence, "resultado.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
