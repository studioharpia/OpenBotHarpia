// Real dev renderer, preload and SQLite. Only avatar fields of the selected test agent are changed and restored.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find((r) => r.service === "app" && resolve(r.projectRoot) === process.cwd());
if (!instance) throw new Error("No development instance belongs to this checkout.");
assert(instance?.profile.startsWith("OpenBot Dev wt-"));
assertMutationAllowed({
  command: "avatar-art-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("avatar-art-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = session;
page.setDefaultTimeout(10000);
const out = resolve("specs/evidencias/novos-avatares");
await mkdir(out, { recursive: true });
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const before = await page.evaluate(async () =>
  (await window.openbot.agent.listAgents()).map((a) => ({
    id: a.id,
    name: a.name,
    avatarSeed: a.avatarSeed,
    avatarHue: a.avatarHue,
    avatarColor: a.avatarColor ?? null,
  })),
);
const selectedName = await page
  .getByRole("button", { name: "Ver configurações do agente", exact: true })
  .getByRole("heading")
  .textContent();
const original = before.find((agent) => agent.name === selectedName);
assert(original, "Selected agent must exist");
const id = original.id;
let passed = false;
const timings: number[] = [];
const read = () =>
  page.evaluate(async (agentId) => (await window.openbot.agent.listAgents()).find((a) => a.id === agentId), id);
const open = async () => {
  await page
    .locator(".provider-update-toast")
    .getByRole("button", { name: "Fechar notificação", exact: true })
    .evaluateAll((buttons) => {
      for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
    });
  if (!(await page.getByRole("button", { name: "Editar avatar do agente", exact: true }).isVisible()))
    await page.getByRole("button", { name: "Ver configurações do agente", exact: true }).click();
  if (!(await page.getByRole("dialog", { name: "Editor de avatar", exact: true }).isVisible()))
    await page.getByRole("button", { name: "Editar avatar do agente", exact: true }).click();
  await page.getByRole("dialog", { name: "Editor de avatar", exact: true }).waitFor();
};
const saved = async (seed: string) => {
  await page.waitForFunction(
    async ({ agentId, expected }) =>
      (await window.openbot.agent.listAgents()).find((a) => a.id === agentId)?.avatarSeed === expected,
    { agentId: id, expected: seed },
  );
};
const screenshot = async (name: string) => {
  await page.bringToFront();
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  if (process.platform !== "darwin") {
    await page.screenshot({ path: resolve(out, name) });
    return;
  }
  // Electron's CDP image omits the native window's overlay surfaces on this Mac.
  // Capture the real window of the already-verified browser process instead.
  const cdp = await session.browser.newBrowserCDPSession();
  const info = await cdp.send("SystemInfo.getProcessInfo");
  await cdp.detach();
  const pid = info.processInfo.find((process) => process.type === "browser")?.id;
  assert(pid && Number.isInteger(pid));
  execFileSync("/usr/bin/osascript", [
    "-e",
    `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`,
  ]);
  const windows = JSON.parse(
    execFileSync(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("CoreGraphics"); const windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))); JSON.stringify(windows.filter(w=>w.kCGWindowOwnerPID===${pid}&&w.kCGWindowName==="OpenBot"&&w.kCGWindowBounds.Width>1000).map(w=>w.kCGWindowNumber));`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert(Array.isArray(windows) && windows.length === 1 && Number.isInteger(windows[0]));
  execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(windows[0]), resolve(out, name)]);
};
try {
  await page.bringToFront();
  await open();
  // Start with the neutral released eyes so every shape uses the same resting face.
  await page.getByRole("button", { name: "Olhos 1", exact: true }).click();
  for (const [index, shape] of [
    "star",
    "heart",
    "bean",
    "moon",
    "flower",
    "cat",
    "rabbit",
    "ghost",
    "arch",
    "bolt",
  ].entries()) {
    await page.getByRole("button", { name: `Forma ${index + 11}`, exact: true }).click();
    await saved(`${id}:openbot-art-v1:${shape}:neutre:plush`);
  }
  checks.push("Dez novas formas selecionadas pela interface e persistidas pelo IPC");
  await page.getByRole("button", { name: "Forma 11", exact: true }).click();
  for (const [index, eye] of [
    "hearts",
    "stars",
    "happy",
    "wink",
    "sleepy",
    "curious",
    "focused",
    "spirals",
  ].entries()) {
    await page.getByRole("button", { name: `Olhos ${index + 17}`, exact: true }).click();
    await saved(`${id}:openbot-art-v1:star:${eye}:plush`);
  }
  checks.push("Oito novos pares de olhos selecionados e persistidos");
  await page.getByRole("button", { name: "Olhos 17", exact: true }).click();
  await page.getByRole("button", { name: "Cor do avatar: Vermelho", exact: true }).click();
  await page.waitForFunction(
    async (agentId) => (await window.openbot.agent.listAgents()).find((a) => a.id === agentId)?.avatarHue === 0,
    id,
  );
  const red = await read();
  assert.equal(red?.avatarHue, 0);
  await page.getByRole("button", { name: "Forma 11", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("01-formas-olhos-vermelho.png");
  for (const label of ["Azul", "Verde", "Violeta", "Rosa", "Marrom", "Cinza", "Vermelho", "Azul"]) {
    const colour = page.getByRole("button", { name: `Cor do avatar: ${label}`, exact: true });
    await colour.scrollIntoViewIfNeeded();
    const elapsed = await colour.evaluate(async (button) => {
      const start = performance.now();
      if (!(button instanceof HTMLButtonElement)) throw new Error("Colour choice is not a button.");
      button.click();
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return performance.now() - start;
    });
    timings.push(elapsed);
    const expected: Record<string, number> = {
      Azul: 215,
      Verde: 150,
      Violeta: 280,
      Rosa: 320,
      Marrom: 55,
      Cinza: 0,
      Vermelho: 0,
    };
    if (label === "Rosa" || label === "Marrom" || label === "Cinza") {
      const hex: Record<string, string> = { Rosa: "#f27ba5", Marrom: "#8b5e3c", Cinza: "#a3a3a3" };
      await page.waitForFunction(
        async ({ agentId, color }) =>
          (await window.openbot.agent.listAgents()).find((a) => a.id === agentId)?.avatarColor === color,
        { agentId: id, color: hex[label] },
      );
    } else {
      await page.waitForFunction(
        async ({ agentId, hue }) =>
          (await window.openbot.agent.listAgents()).find((a) => a.id === agentId)?.avatarHue === hue,
        { agentId: id, hue: expected[label] },
      );
    }
  }
  await page.waitForFunction(
    async (agentId) => (await window.openbot.agent.listAgents()).find((a) => a.id === agentId)?.avatarHue === 215,
    id,
  );
  checks.push("Cores alteradas pela interface, incluindo tons adicionais e ações reversas");
  await page.getByRole("button", { name: "Forma 11", exact: true }).scrollIntoViewIfNeeded();
  await screenshot("02-formas-olhos-azul.png");
  await page.getByRole("tab", { name: "Plano", exact: true }).click();
  await saved(`${id}:openbot-art-v1:star:hearts:flat`);
  await screenshot("03-plano.png");
  await page.getByRole("tab", { name: "Pelúcia", exact: true }).click();
  await saved(`${id}:openbot-art-v1:star:hearts:plush`);
  checks.push("Plano e retorno à Pelúcia preservam forma, olhos e cor");
  await page.getByRole("button", { name: "Forma 1", exact: true }).click();
  await saved(`${id}:openbot-art-v1:cercle:hearts:plush`);
  checks.push("Olhos novos também combinam com corpos antigos");
  await page.getByRole("button", { name: "Forma 11", exact: true }).click();
  await saved(`${id}:openbot-art-v1:star:hearts:plush`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Ver configurações do agente", exact: true }).waitFor();
  assert.equal((await read())?.avatarSeed, `${id}:openbot-art-v1:star:hearts:plush`);
  assert.equal((await read())?.avatarHue, 215);
  await open();
  await screenshot("04-persistencia.png");
  checks.push("Forma, olhos e cor mantidos após recarregar o aplicativo real");
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await page.evaluate(
    async (agent) =>
      window.openbot.agent.updateAgent({
        agentId: agent.id,
        avatarSeed: agent.avatarSeed,
        avatarHue: agent.avatarHue,
        avatarColor: agent.avatarColor,
      }),
    original,
  );
  await saved(original.avatarSeed);
  const after = await page.evaluate(async () =>
    (await window.openbot.agent.listAgents()).map((a) => ({
      id: a.id,
      name: a.name,
      avatarSeed: a.avatarSeed,
      avatarHue: a.avatarHue,
      avatarColor: a.avatarColor ?? null,
    })),
  );
  assert.deepEqual(after, before, "All pre-existing avatars must be restored unchanged");
  checks.push("Todos os avatares anteriores preservados; escolhas temporárias restauradas");
  await writeFile(
    resolve(out, "e2e.json"),
    `${JSON.stringify({ passed, environment: page.url(), instance: instance.instanceId, checks, colourPaintFramesMs: timings, errors, preservedAgents: before.length }, null, 2)}\n`,
  );
  await session.close();
}
// Machine-readable: finite E2E report location, no user content.
process.stdout.write(`${JSON.stringify({ passed, checks: checks.length, report: resolve(out, "e2e.json") })}\n`);
