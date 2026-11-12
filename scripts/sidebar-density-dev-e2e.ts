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
  command: "sidebar-density-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  target: named,
});
const connection = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("sidebar-density-dev-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = connection;
page.setDefaultTimeout(12_000);
const out = resolve("specs/evidencias/sidebar-densidade");
await mkdir(out, { recursive: true });
const original = await page.evaluate(() => localStorage.getItem("openbot:compact-agent-rows"));
const providerId = `density-${Date.now()}`;
let fixtureId: string | undefined;
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
          name: "Evidência",
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
  const click = () =>
    toggle.evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  const selected = await page
    .locator('.agent-row[aria-pressed="true"]')
    .getAttribute("data-task-transfer-agent")
    .catch(() => null);
  if ((await toggle.getAttribute("aria-pressed")) === "true") await click();
  await page.getByRole("button", { name: /^(Compactar lista de agentes|Compact agent list)$/ }).waitFor();
  const candidate = fixture.id;
  const row = page.locator(`.agent-row[data-task-transfer-agent="${candidate}"]`);
  await until(async () => Boolean((await row.locator(".agent-row-preview").textContent())?.trim()));
  const preview = await row.locator(".agent-row-preview").textContent();
  assert(preview);
  assert(preview.trim());
  const name = await row.locator(".agent-row-name").textContent();
  assert(name);
  const measure = async (mode: string) => {
    const sizes = await row.evaluate((element) => {
      const avatar = element.querySelector(".agent-row-avatar")?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const sidebar = element.closest(".sidebar")?.getBoundingClientRect();
      return {
        avatarWidth: avatar?.width ?? 0,
        avatarHeight: avatar?.height ?? 0,
        rowHeight: box.height,
        sidebarWidth: sidebar?.width ?? 0,
      };
    });
    report.sizes.push({ mode, ...sizes });
  };
  const cdp = await page.context().newCDPSession(page);
  const capture = async (name: string) => {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const box = await page.locator("#agent-sidebar").boundingBox();
    assert(box);
    const zoom = metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth;
    const contentBottom = await page
      .locator(".sidebar-agent-item > .agent-row")
      .evaluateAll((rows) => Math.max(...rows.map((row) => row.getBoundingClientRect().bottom)));
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: {
        x: box.x * zoom,
        y: box.y * zoom,
        width: box.width * zoom,
        height: Math.min((contentBottom - box.y + 16) * zoom, box.height * zoom, metrics.layoutViewport.clientHeight),
        scale: 1,
      },
    });
    await writeFile(resolve(out, name), Buffer.from(result.data, "base64"));
  };
  await measure("expanded");
  await capture("01-expandida.png");
  await click();
  await page.getByRole("button", { name: /^(Expandir lista de agentes|Expand agent list)$/ }).waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("openbot:compact-agent-rows")), "true");
  const denseText = await row.textContent();
  assert(denseText?.includes(name.trim()));
  assert(!denseText?.includes(preview));
  const unreadRow = page.locator(`.agent-row[data-task-transfer-agent="${fixture.id}"]`);
  await until(async () => /não lid|unread/i.test((await unreadRow.getAttribute("aria-label")) ?? ""));
  checks.push(
    "Estado de não lida permaneceu disponível em um agente real de teste, sem alterar leitura de agentes do usuário.",
  );
  checks.push("Botão após o + compactou os agentes, manteve nomes e removeu a última mensagem do conteúdo visível.");
  await measure("compact");
  await capture("02-compacta.png");
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  checks.push("Preferência compacta persistiu após recarregar a interface real do dev.");
  await click();
  await page.getByRole("button", { name: /^(Compactar lista de agentes|Compact agent list)$/ }).waitFor();
  assert((await row.textContent())?.includes(preview));
  assert.equal(await page.evaluate(() => localStorage.getItem("openbot:compact-agent-rows")), "false");
  await page.reload({ waitUntil: "domcontentloaded" });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  checks.push("Expandir restaurou as prévias e também persistiu após recarga.");
  if (selected)
    assert.equal(
      await page.locator('.agent-row[aria-pressed="true"]').getAttribute("data-task-transfer-agent"),
      selected,
    );
  checks.push("Alternância preservou a conversa selecionada e não alterou sua navegação.");
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  await page
    .evaluate(
      async ({ id, providerId }) => {
        if (id) await window.openbot.agent.deleteAgent(id);
        await window.openbot.customAgents.delete({ id: providerId });
      },
      { id: fixtureId, providerId },
    )
    .catch((error: Error) => {
      report.passed = false;
      report.failure += ` Cleanup: ${error.message}`;
      process.exitCode = 1;
    });
  // Restore the user's preference, including absence of a saved choice.
  const want = original === "true";
  const toggle = page.locator(".sidebar-density-button");
  if (await toggle.count()) {
    if (((await toggle.getAttribute("aria-pressed")) === "true") !== want)
      await toggle.evaluate((element) => {
        if (element instanceof HTMLElement) element.click();
      });
    if (original === null) await page.evaluate(() => localStorage.removeItem("openbot:compact-agent-rows"));
  }
  await writeFile(resolve(out, "resultado.json"), JSON.stringify(report, null, 2));
  await connection.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
