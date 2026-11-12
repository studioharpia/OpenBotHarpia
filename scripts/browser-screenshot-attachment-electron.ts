import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { AGENT_PROVIDERS, type AgentEvent } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { app, BrowserWindow } from "electron";
import { z } from "zod";
import { AgentStore } from "../src/backend/agent-store";
import { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const argument = (name: string) => {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
  assert(value, `Missing ${name}`);
  return value;
};
const fixtureRoot = argument("fixture-root");
const reportPath = argument("report-path");
const runId = argument("run-id");
const fakeLog = join(fixtureRoot, "provider.jsonl");
const fakeCodex = join(fixtureRoot, "codex");
const checks: string[] = [];
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    '<!doctype html><meta charset="utf-8"><title>Screenshot fixture</title><style>body{font:24px system-ui;background:#f1f5f9;padding:32px;color:#172554}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{padding:32px;background:#2563eb;color:white;border-radius:12px}</style><h1>Captura do navegador</h1><p>Arquivo entregue como imagem no chat.</p><div class="grid"><div class="card">Post 1</div><div class="card">Post 2</div><div class="card">Post 3</div></div>',
  );
});
const logSchema = z.object({ callId: z.string(), success: z.boolean(), shown: z.boolean(), hasImage: z.boolean() });
const logs = async () => {
  try {
    return (await readFile(fakeLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => logSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
};
const fake = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.160.1"); process.exit(0); }
const LOG = __LOG__;
let buffer = "", thread = 0, turn = 0;
const pending = new Map();
const write = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const finish = (p) => { write({method:"item/completed",params:{threadId:p.threadId,turnId:p.turnId,item:{type:"agentMessage",id:"answer-"+p.turnId,text:"Done.",phase:"final_answer"}}});write({method:"turn/completed",params:{threadId:p.threadId,turn:{id:p.turnId,status:"completed"}}}); };
const issue = (p) => { const id="shot-"+p.turnId+"-"+p.left;pending.set(id,p);write({id,method:"item/tool/call",params:{threadId:p.threadId,turnId:p.turnId,callId:p.callId,namespace:"openbot",tool:"tool_call",arguments:{name:"openbot_browser.screenshot",arguments:p.args}}}); };
const answer = (m) => {
 const p=m.params||{};
 switch(m.method) {
 case "initialize": return write({id:m.id,result:{}});
 case "account/read": return write({id:m.id,result:{account:{type:"chatgpt",email:"fixture@example.com"}}});
 case "account/rateLimits/read": return write({id:m.id,result:{rateLimits:{limitId:"codex",primary:null,secondary:null},rateLimitsByLimitId:null}});
 case "model/list": return write({id:m.id,result:{data:[{model:"gpt-6-luna",displayName:"GPT-6 Luna"}]}});
 case "plugin/list": return write({id:m.id,result:{marketplaces:[]}});
 case "config/read": return write({id:m.id,result:{config:{mcp_servers:{}},layers:[{name:{type:"user",file:"/fixture/config.toml",profile:null},version:"1",config:{mcp_servers:{}}}]}});
 case "config/batchWrite": return write({id:m.id,result:{}});
 case "thread/start": return write({id:m.id,result:{thread:{id:"fixture-thread-"+(++thread),turns:[]}}});
 case "thread/resume": case "thread/read": return write({id:m.id,result:{thread:{id:p.threadId,turns:[]}}});
 case "thread/unsubscribe": return write({id:m.id,result:{status:"Unsubscribed"}});
 case "thread/turns/list": case "thread/items/list": return write({id:m.id,result:{data:[],nextCursor:null}});
 case "turn/start": {
  const turnId="fixture-turn-"+(++turn);write({id:m.id,result:{turn:{id:turnId,status:"inProgress",items:[]}}});write({method:"turn/started",params:{threadId:p.threadId,turn:{id:turnId}}});
  const text=(p.input||[]).map(x=>x.text||"").join("\n");const match=[...text.matchAll(/BROWSER_SHOT <<([\s\S]*?)>>/g)].at(-1);
  if(!match)return finish({threadId:p.threadId,turnId});
  const {repeat=1,...args}=JSON.parse(match[1]);return issue({threadId:p.threadId,turnId,callId:"capture-"+turnId,args,left:repeat});
 }
 case "turn/interrupt": write({id:m.id,result:{}});return write({method:"turn/completed",params:{threadId:p.threadId,turn:{id:p.turnId,status:"interrupted"}}});
 default: return write({id:m.id,error:{code:-32601,message:"Unknown fixture method"}});
 }
};
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line)continue;const m=JSON.parse(line);if(m.method&&m.id!==undefined)answer(m);else if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);const r=m.result||{};const items=r.contentItems||[];const shown=items.some(x=>{try{return x.type==="inputText"&&JSON.parse(x.text).status==="shown";}catch{return false;}});appendFileSync(LOG,JSON.stringify({callId:p.callId,success:r.success===true,shown,hasImage:items.some(x=>x.type==="inputImage")})+"\n");if(--p.left>0)issue(p);else finish(p);}}});
`;

void main().catch((error) => {
  process.stderr.write(`${redactText(String(error))}\n`);
  app.exit(1);
});
async function main() {
  app.setPath("userData", join(fixtureRoot, "profile"));
  app.setPath("sessionData", join(fixtureRoot, "session"));
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  await writeFile(fakeCodex, fake.replace("__LOG__", JSON.stringify(fakeLog)), { mode: 0o755 });
  process.env.OPENBOT_CODEX_PATH = fakeCodex;
  const { AgentService } = await import("../src/backend/agent-service");
  const state = join(fixtureRoot, "state");
  const database = new OpenBotDatabase(state);
  const store = new AgentStore(state, join(fixtureRoot, "home"), database);
  const mailbox = new MailboxStore(state, store.sharedRoot, database);
  let browser: BrowserHost | undefined;
  let agents: InstanceType<typeof AgentService> | undefined;
  let passed = false;
  let failure = "";
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    await app.whenReady();
    const window = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      focusable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    browser = new BrowserHost(window, store.downloadsRoot, join(fixtureRoot, "tabs.json"));
    agents = new AgentService({
      store,
      mailbox,
      browser,
      preferredProvider: "codex",
      offProviders: AGENT_PROVIDERS.filter((p) => p !== "codex"),
      timezone: () => "UTC",
    });
    const service = agents;
    const events: AgentEvent[] = [];
    service.on("event", (event) => events.push(event));
    await runCauseEffect(service.initialize());
    const owner = await runCauseEffect(
      service.createAgent({
        name: "Screenshot",
        description: "Fixture",
        avatarSeed: "shot",
        avatarHue: null,
        initialMessage: "Hello.",
      }),
    );
    await waitFor(() => service.listQueue(owner.id).deliveries.every((d) => d.status === "completed"));
    const agent = service.listAgents().find((item) => item.id === owner.id);
    assert(agent?.threadId);
    const tab = await runCauseEffect(browser.open(`http://127.0.0.1:${address.port}/`, agent.threadId, agent.id));
    const attachments = (threadId = agent.threadId) =>
      database.readConversation(agent.id, threadId).messages.flatMap((m) => m.attachments ?? []);
    const ask = async (args: Record<string, string | boolean | number>, taskId?: string) => {
      const before = (await logs()).length;
      await runCauseEffect(
        service.sendMessage({
          agentId: agent.id,
          text: `BROWSER_SHOT <<${JSON.stringify(args)}>>`,
          ...(taskId ? { taskId } : {}),
        }),
      );
      await waitFor(async () => (await logs()).length >= before + Number(args.repeat ?? 1));
      await waitFor(() => service.listQueue(agent.id).deliveries.every((d) => d.status === "completed"));
      return (await logs()).slice(before);
    };
    const inspect = await ask({ tabId: tab.id });
    assert(inspect[0]?.success && inspect[0].hasImage && !inspect[0].shown);
    assert.equal(attachments().length, 0);
    checks.push("Inspection returns the browser image to the agent without adding a chat attachment.");
    const attached = await ask({ tabId: tab.id, attach: true, repeat: 2 });
    assert(attached.every((item) => item.success && item.shown));
    assert.equal(attachments().length, 1);
    const image = attachments()[0];
    assert(image);
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.previewKind, "image");
    assert(
      events.some(
        (event) =>
          event.type === "conversation" &&
          event.snapshot.messages.some((message) => message.attachments?.some((file) => file.id === image.id)),
      ),
    );
    const managedImage = await runCauseEffect(mailbox.resolveAttachment(image.id));
    assert(managedImage);
    const png = await readFile(managedImage.path);
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert(png.byteLength > 1000);
    await writeFile(join(dirname(reportPath), "capture.png"), png);
    checks.push("attach=true publishes a managed PNG preview in the conversation; retry keeps one attachment.");
    const task = await runCauseEffect(service.startTask({ agentId: agent.id, text: "Hello task." }));
    await waitFor(() => service.listQueue(agent.id).deliveries.every((d) => d.status === "completed"));
    const taskTab = await runCauseEffect(
      browser.open(`http://127.0.0.1:${address.port}/task`, task.threadId, agent.id),
    );
    const taskResult = await ask({ tabId: taskTab.id, attach: true }, task.id);
    assert(taskResult[0]?.shown);
    assert.equal(attachments(task.threadId).length, 1);
    assert.equal(attachments().length, 1);
    checks.push("A side task receives its own image without attaching it to the agent's main chat.");
    const foreign = await runCauseEffect(
      browser.open(`http://127.0.0.1:${address.port}/foreign`, "foreign-thread", "foreign-agent"),
    );
    const denied = await ask({ tabId: foreign.id, attach: true });
    assert.equal(denied[0]?.success, false);
    assert.equal(attachments().length, 1);
    checks.push("A foreign agent's tab remains inaccessible and creates no attachment.");
    await runCauseEffect(browser.close(tab.id));
    const closed = await ask({ tabId: tab.id, attach: true });
    assert.equal(closed[0]?.success, false);
    assert.equal(attachments().length, 1);
    checks.push("A failed capture cannot claim shown or create a chat attachment.");
    await runCauseEffect(service.stop());
    agents = undefined;
    database.close();
    const reopened = new OpenBotDatabase(state);
    try {
      await runCauseEffect(reopened.initialize());
      const restored = reopened.readConversation(agent.id, agent.threadId).messages.flatMap((m) => m.attachments ?? []);
      assert.equal(restored.length, 1);
      assert.equal(restored[0]?.id, image.id);
      const reopenedMailbox = new MailboxStore(state, store.sharedRoot, reopened);
      await runCauseEffect(reopenedMailbox.initialize());
      const restoredFile = await runCauseEffect(reopenedMailbox.resolveAttachment(image.id));
      assert(restoredFile);
      const restoredBytes = await readFile(restoredFile.path);
      assert.equal(
        createHash("sha256").update(restoredBytes).digest("hex"),
        createHash("sha256").update(png).digest("hex"),
      );
      assert.deepEqual(restoredBytes, png);
      assert.equal(
        reopened.readConversation(agent.id, task.threadId).messages.flatMap((m) => m.attachments ?? []).length,
        1,
      );
    } finally {
      reopened.close();
    }
    checks.push("The main and task images, managed file and checksum survive SQLite reopen.");
    passed = true;
  } catch (error) {
    failure = redactText(String(error));
    process.exitCode = 1;
  } finally {
    if (agents) await runCauseEffect(agents.stop()).catch(() => {});
    database.close();
    if (browser) await runCauseEffect(browser.destroy()).catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          runId,
          passed,
          checks,
          error: failure,
          environment:
            "Owned Electron browser, loopback page, real AgentService/Codex adapter/SQLite and a controlled provider; no real account or installed app.",
        },
        null,
        2,
      ),
    );
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(passed ? 0 : 1);
  }
}
async function waitFor(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error("Fixture state did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
