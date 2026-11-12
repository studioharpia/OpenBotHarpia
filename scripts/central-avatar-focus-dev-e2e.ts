// Integrated dev navigation and composer focus. Only the temporary ACP provider is a fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenBotLogger } from "@openbot/logging";
import type { Locator, Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const named = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === named && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "central-avatar-focus-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  ...(named === undefined ? {} : { target: named }),
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("central-avatar-focus-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve(".openbot-build/central-avatar-foco");
const evidence = resolve("specs/evidencias/central-avatar-foco");
await mkdir(out, { recursive: true });
await mkdir(evidence, { recursive: true });
const providerId = `avatar-focus-${Date.now()}`;
const checks: string[] = [];
const errors: string[] = [];
let agentId: string | undefined;
let page: Page | undefined;
const report = {
  passed: false,
  url: `http://localhost:${instance.rendererPort}`,
  profile: instance.profile,
  checks,
  errors,
  failure: "",
};
const preferences = await main.evaluate(() => ({
  sections: localStorage.getItem("openbot:central-task-sections"),
  panel: localStorage.getItem("openbot:agent-panel:local"),
}));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Timed out waiting for focus/navigation state");
    await delay(30);
  }
}
try {
  const fake = resolve(out, "provider.ts");
  await writeFile(
    fake,
    `import { serveFakeAcpAgent } from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};let count=0;serveFakeAcpAgent({initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"focus-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),"session/new":(r,p)=>p.reply(r,{sessionId:"focus-"+(++count),models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),"session/load":(r,p)=>p.reply(r,{models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),"session/prompt":(r,p)=>{p.say(r.params.sessionId,"Preparação concluída.");p.reply(r,{stopReason:"end_turn"});}});`,
  );
  await main.evaluate(
    async ({ id, fake, command }) => {
      await window.openbot.customAgents.save({
        id,
        name: "Focus fixture",
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
          name: "Evidência — foco na conversa",
          description: "Teste temporário de navegação",
          avatarSeed: "focus",
          avatarHue: null,
          initialMessage: "Preparar teste de foco.",
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
      return !history.activeTurnId && history.messages.some((message) => message.author === "assistant");
    }, agent.id),
  );
  const answer = await main.evaluate(
    async (id) =>
      (await window.openbot.agent.readConversation(id)).messages.findLast((message) => message.author === "assistant"),
    agent.id,
  );
  assert(answer);
  for (const title of ["Foco A", "Foco B"]) {
    const task = await main.evaluate((input) => window.openbot.agent.branchTask(input, "local"), {
      agentId: agent.id,
      taskId: null,
      messageId: answer.id,
      requestId: crypto.randomUUID(),
    });
    await main.evaluate((input) => window.openbot.agent.renameTask(input, "local"), {
      agentId: agent.id,
      taskId: task.id,
      title,
    });
  }
  const opening = main.context().waitForEvent("page");
  await main.evaluate((id) => window.openbot.openChatWindow({ agentId: id, serverId: "local" }), agent.id);
  page = await opening;
  const owned = page;
  owned.on("pageerror", (error) => errors.push(error.message));
  owned.setDefaultTimeout(12_000);
  await owned.waitForURL((url) => url.searchParams.get("agent") === agent.id);
  await owned.setViewportSize({ width: 1250, height: 1000 });
  const click = async (locator: Locator) => {
    await locator.waitFor({ state: "visible" });
    await locator.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  };
  const focused = () =>
    owned.evaluate(() => {
      const active = document.activeElement;
      return (
        active instanceof HTMLElement &&
        active.matches('.composer-editor-surface[contenteditable="true"]') &&
        !active.closest("[inert], [hidden]")
      );
    });
  const editorText = () => owned.evaluate(() => document.activeElement?.textContent ?? "");
  const type = async (text: string) => {
    assert(await focused(), "The open conversation must already own focus");
    await owned.evaluate((value) => {
      document.execCommand("insertText", false, value);
    }, text);
  };
  await until(focused);
  await type("Rascunho principal");
  assert.equal(await editorText(), "Rascunho principal");
  checks.push("Janela de conversa abriu com o prompt ativo e aceitou digitação imediata sem clicar no input.");
  await owned.locator(".side-panel-toggle").waitFor();
  if ((await owned.locator(".side-panel-toggle").getAttribute("aria-expanded")) === "false")
    await click(owned.locator(".side-panel-toggle"));
  const launch = owned.getByRole("button", { name: /Abrir Central do agente|Open agent central/i });
  if (await launch.count()) await click(launch);
  const central = owned.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  await central.getByRole("heading", { name: agent.name, exact: true }).waitFor();
  assert.equal(await central.getByRole("button", { name: /^(Conversa principal|Main conversation)$/ }).count(), 0);
  const photo = central.getByRole("button", { name: /^(Abrir o chat principal|Open main chat)$/ });
  await photo.waitFor();
  for (const label of [/^(Concluídas|Completed)$/, /^(Em andamento|In progress)$/]) {
    const section = central.getByRole("button", { name: label });
    if ((await section.getAttribute("aria-expanded")) === "false") await click(section);
  }
  await click(central.locator('.agent-central-task-main[title="Foco A"]'));
  await until(focused);
  await type("Rascunho A");
  assert.equal(await editorText(), "Rascunho A");
  await click(central.locator('.agent-central-task-main[title="Foco B"]'));
  await until(focused);
  await type("Rascunho B");
  assert.equal(await editorText(), "Rascunho B");
  await click(central.locator('.agent-central-task-main[title="Foco A"]'));
  await until(focused);
  assert.equal(await editorText(), "Rascunho A");
  checks.push("Troca de tarefas pela Central focou o prompt correto e preservou rascunhos separados de A e B.");
  await click(photo);
  await until(focused);
  assert.equal(await editorText(), "Rascunho principal");
  checks.push(
    "Foto da Central abriu a conversa principal e restaurou seu rascunho; a linha fixa e seu menu foram removidos.",
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
  await capture("01-central-avatar.png");
  await click(central.locator('.agent-central-task-main[title="Foco A"]'));
  await until(focused);
  await click(owned.locator(".side-panel-toggle"));
  await owned.setViewportSize({ width: 1650, height: 1000 });
  const tabB = owned.locator('.agent-threads-tab[title="Foco B"]');
  await tabB.waitFor();
  await click(tabB);
  await until(focused);
  assert.equal(await editorText(), "Rascunho B");
  checks.push("Troca pela topbar focou o prompt e recuperou o rascunho da tarefa B.");
  await click(owned.locator('.agent-threads-tab[title="Foco A"]'));
  await until(focused);
  await capture("02-tarefa-focada.png");
  // The settings field is another editing flow and must keep focus during live updates.
  await click(owned.locator(".side-panel-toggle"));
  await click(central.getByRole("button", { name: /^(Configurações do agente|Agent settings)$/ }));
  const field = owned.locator('aside.settings-panel input:not([type="file"]), aside.settings-panel textarea').first();
  await field.waitFor();
  await field.evaluate((element) => {
    if (element instanceof HTMLElement) element.focus();
  });
  await main.evaluate((input) => window.openbot.agent.renameTask(input, "local"), {
    agentId: agent.id,
    taskId:
      (await main.evaluate(
        async (id) => (await window.openbot.agent.listTasks(id)).tasks.find((task) => task.title === "Foco B")?.id,
        agent.id,
      )) ?? "",
    title: "Foco B atualizado",
  });
  assert(await field.evaluate((element) => element.ownerDocument.activeElement === element));
  checks.push(
    "Atualização de tarefa não roubou o foco de outro campo nas configurações; atualizações não disparam autofoco do prompt.",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  if (page) {
    report.failure += JSON.stringify(
      await page.evaluate(() => ({
        activeTag: document.activeElement?.tagName,
        activeLabel: document.activeElement?.getAttribute("aria-label"),
        activeClass: document.activeElement?.className,
        focusVisible: document.activeElement?.matches(":focus-visible"),
        touch: navigator.maxTouchPoints,
        popups: document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]').length,
      })),
    );
    await page.screenshot({ path: resolve(out, "falha.png") }).catch(() => {});
    await writeFile(resolve(out, "falha.html"), await page.content()).catch(() => {});
  }
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
  await main.evaluate((saved) => {
    for (const [key, value] of [
      ["openbot:central-task-sections", saved.sections],
      ["openbot:agent-panel:local", saved.panel],
    ]) {
      if (value == null) localStorage.removeItem(key ?? "");
      else localStorage.setItem(key ?? "", value);
    }
  }, preferences);
  await connection.close();
  await writeFile(resolve(evidence, "resultado.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
