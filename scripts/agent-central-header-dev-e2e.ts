// Captures the real dev Central in an owned window without mouse or native window activation.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import type { Page } from "playwright-core";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const named = process.argv.find((arg) => arg.startsWith("--instance="))?.slice(11);
const before = process.argv.includes("--before");
const instance = readDevInstanceRecords().find(
  (entry) => entry.service === "app" && entry.instanceId === named && resolve(entry.projectRoot) === process.cwd(),
);
assert(instance);
assert(instance.profile.startsWith("OpenBot Dev"));
assertMutationAllowed({
  command: "agent-central-header-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: Boolean(named),
  ...(named === undefined ? {} : { target: named }),
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("agent-central-header-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const main = connection.page;
const out = resolve("specs/evidencias/central-header-compacto");
await mkdir(out, { recursive: true });
let owned: Page | undefined;
const storedWidth = await main.evaluate(() => localStorage.getItem("openbot:side-panel-width"));
const errors: string[] = [];
const checks: string[] = [];
let passed = false;
let failure = "";
try {
  const previousId = before ? null : JSON.parse(await readFile(resolve(out, "antes.json"), "utf8")).agentId;
  const agent = await main.evaluate(async (preferredId: string | null) => {
    const windows = await window.openbot.getChatWindows();
    const agents = await window.openbot.agent.listAgents("local");
    return (
      agents.find(
        (agent) =>
          agent.id === preferredId &&
          !windows.some((window) => window.agentId === agent.id && window.serverId === "local"),
      ) ??
      agents.find(
        (agent) => agent.title && !windows.some((window) => window.agentId === agent.id && window.serverId === "local"),
      )
    );
  }, previousId);
  assert(agent);
  const opening = main.context().waitForEvent("page");
  await main.evaluate((agentId) => window.openbot.openChatWindow({ agentId, serverId: "local" }), agent.id);
  const page = await opening;
  await page.waitForURL(
    (url) => url.searchParams.get("window") === "chat" && url.searchParams.get("agent") === agent.id,
  );
  owned = page;
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12_000);
  await page.setViewportSize({ width: 1100, height: 800 });
  const click = async (selector: string) =>
    page.locator(selector).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
  await page.locator(".side-panel-toggle").waitFor();
  if ((await page.locator(".side-panel-toggle").getAttribute("aria-expanded")) === "false")
    await click(".side-panel-toggle");
  const central = page.getByRole("complementary", { name: /Central do agente|Agent central/, exact: true });
  await central.getByRole("heading", { name: agent.name, exact: true }).waitFor();
  await page.locator("[data-sonner-toast] button[aria-label]").evaluateAll((elements) => {
    for (const element of elements)
      if (
        element instanceof HTMLElement &&
        /Fechar notificação|Close toast/.test(element.getAttribute("aria-label") ?? "")
      )
        element.click();
  });
  const session = await page.context().newCDPSession(page);
  const capture = async (filename: string) => {
    const metrics = await session.send("Page.getLayoutMetrics");
    const shot = await session.send("Page.captureScreenshot", {
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
    await writeFile(resolve(out, filename), Buffer.from(shot.data, "base64"));
  };
  if (!before)
    await page
      .getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ })
      .evaluate((element) =>
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })),
      );
  await capture(before ? "01-antes.png" : "02-depois-estreito.png");
  if (before)
    await writeFile(
      resolve(out, "antes.json"),
      JSON.stringify({ agentId: agent.id, agentName: agent.name, url: page.url() }, null, 2),
    );
  else {
    const resize = page.getByRole("separator", { name: /Redimensionar painel|Resize settings panel/ });
    await resize.evaluate((element) =>
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })),
    );
    await capture("03-depois-largo.png");
    const box = await page.locator(".agent-central-profile").boundingBox();
    assert(box);
    const metrics = await session.send("Page.getLayoutMetrics");
    const zoom = metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth;
    const header = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: box.x * zoom, y: box.y * zoom, width: box.width * zoom, height: box.height * zoom, scale: 1 },
    });
    await writeFile(resolve(out, "04-header.png"), Buffer.from(header.data, "base64"));
    await click(".agent-central-profile-settings");
    await central.waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: /^(Central do agente|Agent central)$/ }).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
    await central.getByRole("heading", { name: agent.name, exact: true }).waitFor();
    checks.push(
      "Central real exibida em painel estreito e largo; configurações abrem e o retorno à Central preserva a identidade do agente.",
    );
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (owned && !owned.isClosed()) await owned.screenshot({ path: resolve(out, "falha.png") }).catch(() => undefined);
} finally {
  if (owned && !owned.isClosed()) await owned.close();
  await main.evaluate((value) => {
    if (value === null) localStorage.removeItem("openbot:side-panel-width");
    else localStorage.setItem("openbot:side-panel-width", value);
  }, storedWidth);
  await connection.close();
  const report = {
    passed,
    phase: before ? "before" : "after",
    checks,
    errors,
    failure,
    profile: instance.profile,
    rendererPort: instance.rendererPort,
    productionReinstalled: false,
  };
  await writeFile(
    resolve(out, before ? "antes-resultado.json" : "resultado.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
