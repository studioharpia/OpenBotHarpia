// Real dev sidebar: reversible density toggle and saved preference, without OS mouse input.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const named = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === named && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "prompt-templates-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  target: named,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("prompt-templates-dev-e2e"),
  {
    expectedRendererPort: instance.rendererPort,
    ownerPid: instance.pid,
  },
);
const { page } = connection;
page.setDefaultTimeout(12_000);
const out = resolve("specs/evidencias/templates-prompts");
await mkdir(out, { recursive: true });
const originalDraft = await page.evaluate(() => {
  const dialog = document.querySelector(".templates-dialog");
  if (!dialog?.getClientRects().length) return null;
  const name = dialog.querySelector("input");
  const prompt = dialog.querySelector("textarea");
  return name instanceof HTMLInputElement && prompt instanceof HTMLTextAreaElement
    ? { name: name.value, prompt: prompt.value }
    : null;
});
const ownedTemplateIds: string[] = [];
let ownedPage: import("playwright-core").Page | undefined;
const providerId = `density-${Date.now()}`;
let fixtureId: string | undefined;
let providerSaved = false;
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const report: {
  passed: boolean;
  url: string;
  profile: string;
  checks: string[];
  errors: string[];
  failure: string;
  sizes: { mode: string; avatarWidth: number; avatarHeight: number; rowHeight: number; sidebarWidth: number }[];
} = { passed: false, url: page.url(), profile: instance.profile, checks, errors, failure: "", sizes: [] };
try {
  // Start from a fresh renderer after the shared Layout provider changed, avoiding stale HMR contexts.
  await page.reload({ waitUntil: "domcontentloaded" });
  const toggle = page.locator(".sidebar-density-button");
  await toggle.waitFor();
  const fake = resolve(".openbot-build/sidebar-density-provider.ts");
  await writeFile(
    fake,
    `import {serveFakeAcpAgent} from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};let n=0;serveFakeAcpAgent({initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"density-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),"session/new":(r,p)=>p.reply(r,{sessionId:"density-"+(++n),models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),"session/load":(r,p)=>p.reply(r,{}),"session/prompt":(r,p)=>{p.say(r.params.sessionId,"Mensagem não lida para conferir a lista compacta.");p.reply(r,{stopReason:"end_turn"});}});`,
  );
  await page.evaluate(
    async ({ id, fake, command }) => {
      await window.openbot.customAgents.save({
        id,
        name: "Density fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      });
      await window.openbot.refreshAgentProviders({ automatic: false });
    },
    { id: providerId, fake, command: process.execPath },
  );
  providerSaved = true;
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      assert(Date.now() < deadline, "Fixture state timed out");
      await delay(30);
    }
  };
  await until(() =>
    page.evaluate(
      async (id) => (await window.openbot.agent.listModels()).some((model) => model.id === `${id}/default`),
      providerId,
    ),
  );
  const fixture = await page.evaluate(
    (id) =>
      window.openbot.agent.createAgent(
        {
          name: "Evidência templates",
          description: "Conferência temporária",
          avatarSeed: "density",
          avatarHue: null,
          initialMessage: "Conferir lista.",
          provider: "acp",
          model: `${id}/default`,
        },
        "local",
      ),
    providerId,
  );
  fixtureId = fixture.id;
  await page.evaluate((input) => window.openbot.agent.updateAgent(input, "local"), {
    agentId: fixture.id,
    title: "Teste",
  });
  await until(() =>
    page.evaluate(async (id) => {
      const chat = await window.openbot.agent.readConversation(id);
      return !chat.activeTurnId && chat.messages.some((message) => message.author === "assistant");
    }, fixture.id),
  );
  const answer = await page.evaluate(
    async (id) =>
      (await window.openbot.agent.readConversation(id)).messages.findLast((message) => message.author === "assistant"),
    fixture.id,
  );
  assert(answer);
  await page.evaluate((input) => window.openbot.agent.markConversationUnread(input, "local"), {
    agentId: fixture.id,
    fromMessageId: answer.id,
  });
  const click = (target: import("playwright-core").Locator) => target.click();
  const dismissNotices = async (target: import("playwright-core").Page) => {
    const notices = target
      .locator('[data-sonner-toast][data-front="true"]')
      .getByRole("button", { name: /Fechar notificação|Close toast/, exact: true });
    while (await notices.count()) {
      const close = notices.first();
      const element = await close.elementHandle();
      await close.press("Enter");
      await target.waitForFunction((element) => !element?.isConnected, element);
    }
  };
  const openTemplates = async () => {
    await page
      .locator(".window-rail")
      .getByRole("button", { name: /^(Mais|More)$/ })
      .press("Enter");
    await page.getByRole("menuitem", { name: "Templates", exact: true }).press("Enter");
    await page.getByRole("main", { name: "Templates", exact: true }).waitFor();
    await dismissNotices(page);
  };
  const stamp = `Evidência ${Date.now()}`;
  const nameA = `${stamp} A`;
  const nameB = `${stamp} B`;
  const promptA = "Confira o fluxo completo.\nRegistre a Evidência e descreva o resultado.";
  const promptB = "Organize as próximas etapas sem executar alterações.";
  const addTemplate = async (name: string, prompt: string) => {
    await click(page.getByRole("button", { name: /^(Novo template|New template)$/ }));
    const dialog = page.locator(".templates-dialog");
    await dialog.waitFor();
    await dialog.getByRole("textbox", { name: /^(Nome|Name)$/ }).fill(name);
    await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
    await click(dialog.getByRole("button", { name: /^(Salvar|Save)$/ }));
    await dialog.waitFor({ state: "hidden" });
    const id = await page.evaluate(
      (name) =>
        JSON.parse(localStorage.getItem("openbot:prompt-templates:v1") ?? "[]").find(
          (item: { name: string }) => item.name === name,
        )?.id,
      name,
    );
    assert(id);
    ownedTemplateIds.push(id);
  };
  await openTemplates();
  await addTemplate(nameA, promptA);
  await addTemplate(nameB, promptB);
  const rowA = page.locator(".template-card-open").filter({ hasText: nameA });
  await click(rowA);
  await page.waitForFunction(() => document.activeElement === document.querySelector(".templates-dialog input"));
  await page
    .locator(".templates-dialog")
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill(`${promptA}\nNão envie automaticamente.`);
  await click(page.locator(".templates-dialog").getByRole("button", { name: /^(Salvar|Save)$/ }));
  await page.locator(".templates-dialog").waitFor({ state: "hidden" });
  checks.push("Criou dois templates pela aba e editou um prompt multilinha.");
  const capture = async (target: import("playwright-core").Page, filename: string) => {
    const cdp = await target.context().newCDPSession(target);
    if (filename === "04-editor.png")
      await target.locator(".templates-dialog").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      });
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const dialogBox = filename === "04-editor.png" ? await target.locator(".templates-dialog").boundingBox() : null;
    const zoom = metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth;
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: {
        x: dialogBox ? dialogBox.x * zoom : 0,
        y: dialogBox ? dialogBox.y * zoom : 0,
        width: dialogBox ? dialogBox.width * zoom : metrics.layoutViewport.clientWidth,
        height: dialogBox ? dialogBox.height * zoom : metrics.layoutViewport.clientHeight,
        scale: 1,
      },
    });
    await writeFile(resolve(out, filename), Buffer.from(shot.data, "base64"));
    await cdp.detach();
  };
  await capture(page, "01-templates.png");
  await click(rowA);
  await page.waitForFunction(() => document.activeElement === document.querySelector(".templates-dialog input"));
  await capture(page, "04-editor.png");
  await page
    .locator(".templates-dialog")
    .getByRole("button", { name: /^(Cancelar|Cancel)$/ })
    .press("Enter");
  await page.locator(".templates-dialog").waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-density-button").waitFor();
  await openTemplates();
  await rowA.waitFor();
  assert((await rowA.textContent())?.includes("Não envie automaticamente."));
  checks.push("Nome e prompt editado persistiram após recarga.");
  const opened = page.context().waitForEvent("page");
  await page.evaluate((id) => window.openbot.openChatWindow({ agentId: id, serverId: "local" }), fixture.id);
  ownedPage = await opened;
  const chat = ownedPage;
  chat.setDefaultTimeout(12000);
  chat.on("pageerror", (error) => errors.push(error.message));
  await chat.waitForURL((url) => url.searchParams.get("agent") === fixture.id);
  await chat.setViewportSize({ width: 1400, height: 900 });
  await dismissNotices(chat);
  const sidePanel = chat.locator('.side-panel-toggle[aria-expanded="true"]');
  if (await sidePanel.count()) await click(sidePanel);
  const input = chat.locator('.composer-editor-surface[contenteditable="true"]:visible').first();
  await input.waitFor();
  const count = () =>
    page.evaluate(
      async (id) =>
        (await window.openbot.agent.readConversation(id)).messages.filter((message) => message.author === "user")
          .length,
      fixture.id,
    );
  const baseline = await count();
  await input.fill(`/${stamp}`);
  await chat.getByRole("option", { name: nameA, exact: true }).waitFor();
  await input.press("ArrowDown");
  await input.press("Enter");
  assert.equal(await input.innerText(), promptB);
  assert.equal(await count(), baseline);
  checks.push("Setas + Enter substituíram o input pelo template escolhido sem enviar mensagem.");
  await input.fill(`/${nameA}`);
  const option = chat.getByRole("option", { name: nameA, exact: true });
  await option.waitFor();
  await click(option);
  assert.equal(await input.innerText(), `${promptA}\nNão envie automaticamente.`);
  assert.equal(await count(), baseline);
  checks.push("Clique inseriu o prompt completo e manteve o envio pendente.");
  await capture(chat, "02-prompt-preenchido.png");
  await input.fill(`/${stamp}`);
  await chat.getByRole("option", { name: nameA, exact: true }).waitFor();
  await capture(chat, "03-seletor.png");
  await input.press("Escape");
  await input.fill("Mensagem de teste anterior");
  await input.fill(`/${nameB}`);
  await chat.getByRole("option", { name: nameB, exact: true }).waitFor();
  await input.press("Enter");
  await input.press("Enter");
  await until(async () => (await count()) === baseline + 1);
  const history = await page.evaluate((id) => window.openbot.agent.readConversation(id), fixture.id);
  assert.equal(history.messages.findLast((message) => message.author === "user")?.text, promptB);
  checks.push("Somente um novo Enter enviou o prompt selecionado ao provedor ACP local.");
  const rowB = page.locator(".template-card").filter({ hasText: nameB });
  await rowB.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^(Excluir|Delete)$/, exact: true }).waitFor();
  await capture(page, "05-acoes.png");
  await page.getByRole("menuitem", { name: /^(Excluir|Delete)$/, exact: true }).press("Enter");
  await click(page.getByRole("alertdialog").getByRole("button", { name: /^(Excluir|Delete)$/, exact: true }));
  await rowB.waitFor({ state: "hidden" });
  checks.push("Exclusão pela aba removeu somente o template de teste confirmado.");
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (ownedPage && !ownedPage.isClosed()) await ownedPage.close();
  await page
    .evaluate(
      async ({ id, providerId, ownedIds, providerSaved }) => {
        if (id) await window.openbot.agent.deleteAgent(id);
        if (providerSaved) await window.openbot.customAgents.delete({ id: providerId });
        const key = "openbot:prompt-templates:v1";
        const current = JSON.parse(localStorage.getItem(key) ?? "[]");
        localStorage.setItem(
          key,
          JSON.stringify(current.filter((item: { id: string; name: string }) => !ownedIds.includes(item.id))),
        );
        window.dispatchEvent(new StorageEvent("storage", { key }));
      },
      { id: fixtureId, providerId, ownedIds: ownedTemplateIds, providerSaved },
    )
    .catch((error: Error) => {
      report.passed = false;
      report.failure += error.message;
      process.exitCode = 1;
    });
  if (originalDraft && !page.isClosed()) {
    const dialog = page.locator(".templates-dialog");
    if (!(await dialog.isVisible())) {
      await page.getByRole("button", { name: /^(Novo template|New template)$/ }).press("Enter");
      await page.waitForFunction(() => document.activeElement === document.querySelector(".templates-dialog input"));
    }
    await dialog.getByRole("textbox", { name: /^(Nome|Name)$/ }).fill(originalDraft.name);
    await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill(originalDraft.prompt);
  }
  await writeFile(resolve(out, "resultado.json"), JSON.stringify(report, null, 2));
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
