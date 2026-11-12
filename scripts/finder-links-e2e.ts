import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const root = process.cwd(),
  out = join(root, "specs/evidencias/mostrar-no-finder");
await mkdir(out, { recursive: true });
const fake = "/tmp/openbot-finder-acp.ts";
await writeFile(
  fake,
  `import{serveFakeAcpAgent}from${JSON.stringify(root + "/scripts/provider-fakes/acp-agent.ts")};serveFakeAcpAgent({initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:'finder',version:'1'},agentCapabilities:{loadSession:true}}),'session/new':(r,p)=>p.reply(r,{sessionId:'finder',models:{availableModels:[{modelId:'default',name:'Default'}],currentModelId:'default'}}),'session/load':(r,p)=>p.reply(r,{models:{availableModels:[{modelId:'default',name:'Default'}],currentModelId:'default'}}),'session/prompt':(r,p)=>{p.say(r.params.sessionId,'[Mostrar pasta de teste](reports/)');p.reply(r,{stopReason:'end_turn'});}});`,
);
const instance = readDevInstanceRecords().find((r) => r.projectRoot === root && r.service === "app");
if (!instance) throw Error("Start this checkout dev instance first");
assertMutationAllowed({
  command: "finder-links-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const s = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("finder-fixture"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const p = s.page;
p.setDefaultTimeout(12000);
const providerId = "finder-fixture-" + Date.now();
let id: string | undefined;
try {
  await p.keyboard.press("Escape");
  await p.evaluate(
    async ({ providerId, fake, command }) =>
      window.openbot.customAgents.save({
        id: providerId,
        name: "Finder fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      }),
    { providerId, fake, command: process.execPath },
  );
  await p.evaluate(() => window.openbot.refreshAgentProviders({ automatic: false }));
  await p.waitForFunction(
    async (id) => (await window.openbot.agent.listModels()).some((m) => m.id === id + "/default"),
    providerId,
  );
  const a = await p.evaluate(
    async (providerId) =>
      window.openbot.agent.createAgent({
        name: "Evidência Finder",
        description: "Fixture temporária",
        avatarSeed: "finder",
        avatarHue: null,
        initialMessage: "Mostrar pasta",
        provider: "acp",
        model: providerId + "/default",
      }),
    providerId,
  );
  id = a.id;
  await mkdir(join(a.workspacePath, "reports"), { recursive: true });
  await p.locator(`[data-chat-id="${id}"] > .agent-row`).click();
  const link = p.getByRole("button", { name: /Abrir pasta.*reports/ });
  await link.waitFor();
  await link.click({ button: "right" });
  await p.getByRole("menuitem", { name: "Mostrar no Finder", exact: true }).waitFor();
  await p.screenshot({ path: out + "/menu.png", animations: "disabled" });
  await p.getByRole("menuitem", { name: "Mostrar no Finder", exact: true }).click();
  const restrictions = await p.evaluate(async (agentId) => {
    const checks = [];
    for (const operation of [
      () => window.openbot.agent.openWorkspaceFile({ agentId, path: "reports/", action: "open" }),
      () => window.openbot.agent.previewWorkspaceFile({ agentId, path: "reports/" }),
    ]) {
      let refused = false;
      try {
        await operation();
      } catch {
        refused = true;
      }
      checks.push(refused);
    }
    return checks;
  }, id);
  if (restrictions.some((x) => !x)) throw Error("Folder open/preview restriction changed");
  const expected = join(a.workspacePath, "reports") + "/";
  let selection = "",
    target = "";
  for (let i = 0; i < 100; i++) {
    try {
      selection = execFileSync(
        "/usr/bin/osascript",
        ["-e", 'tell application "Finder" to get POSIX path of (item 1 of (get selection) as alias)'],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      target = execFileSync(
        "/usr/bin/osascript",
        ["-e", 'tell application "Finder" to get POSIX path of (target of front window as alias)'],
        { encoding: "utf8" },
      ).trim();
      if (selection === expected || target === expected) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // Machine-readable: observed Finder paths from this isolated fixture.
  process.stdout.write(JSON.stringify({ selection, target, expected }) + "\n");
  if (selection !== expected && target !== expected) throw Error("Finder did not show fixture folder");
  await writeFile(
    out + "/resultado.json",
    JSON.stringify(
      {
        passed: true,
        url: p.url(),
        menu: true,
        finderSelectedFixtureFolder: true,
        folderOpenRefused: restrictions[0],
        folderPreviewRefused: restrictions[1],
        expected,
      },
      null,
      2,
    ) + "\n",
  ); // Machine-readable: focused E2E completion.
  process.stdout.write("Menu e seleção real no Finder confirmados\n");
} finally {
  if (id) await p.evaluate((id) => window.openbot.agent.deleteAgent(id), id);
  await p.evaluate((id) => window.openbot.customAgents.delete({ id }), providerId);
  await s.close();
}
