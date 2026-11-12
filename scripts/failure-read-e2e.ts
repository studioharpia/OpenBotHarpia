// Real development renderer/IPC and SQLite. Only a branch created by this script is seeded with failures.

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find((r) => r.service === "app" && resolve(r.projectRoot) === process.cwd());
assert(instance, "Nenhuma instância de desenvolvimento deste checkout foi encontrada.");
assert(instance.profile.startsWith("OpenBot Dev wt-"));
assertMutationAllowed({
  command: "failure-read-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("failure-read-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = connection;
page.setDefaultTimeout(10000);
const out = resolve("specs/evidencias/erros-lidos");
await mkdir(out, { recursive: true });
const db = new Database(join(homedir(), "Library/Application Support", instance.profile, "openbot.db"), {
  readwrite: true,
});
const checks: string[] = [];
let fixture: { id: string; agentId: string; threadId: string } | undefined;
let passed = false;
let failure = "";
try {
  await page.bringToFront();
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  fixture = await page.evaluate(async () => {
    const agentId = "chief";
    const snapshot = await window.openbot.agent.readConversation(agentId);
    const answer = snapshot.messages.findLast(
      (m) => m.author === "assistant" && m.status === "completed" && !m.itemType,
    );
    if (!answer) throw new Error("Fixture needs a completed answer");
    const task = await window.openbot.agent.branchTask({
      agentId,
      taskId: null,
      messageId: answer.id,
      requestId: crypto.randomUUID(),
    });
    await window.openbot.agent.renameTask({ agentId, taskId: task.id, title: "Evidência — aviso de falha lido" });
    return { id: task.id, agentId, threadId: task.threadId };
  });
  const { id: taskId, agentId, threadId } = fixture;
  const fail = (at: string) => {
    const result = db
      .query(
        "UPDATE projection_agent_threads SET outcome='failed', error='Falha controlada de Evidência', updated_at=? WHERE thread_id=? AND agent_id=? AND title=?",
      )
      .run(at, threadId, agentId, "Evidência — aviso de falha lido");
    assert.equal(result.changes, 1);
  };
  const reload = async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".app-loading").waitFor({ state: "hidden", timeout: 20000 });
    await page.getByRole("button", { name: "Agentes", exact: true }).click();
    await page.locator(".agent-row").first().waitFor();
  };
  fail(new Date().toISOString());
  await reload();
  // Reading main does not acknowledge the side thread.
  await page.locator('[data-chat-id="chief"] > .agent-row').click();
  const taskButton = page
    .getByRole("button", { name: "Evidência — aviso de falha lido", exact: false })
    .filter({ has: page.locator(".sidebar-agent-thread-title") });
  await taskButton.waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.sidebar-agent-thread-button[title="Evidência — aviso de falha lido"]')
        ?.getAttribute("data-attention") === "failed",
  );
  checks.push("Reading the main chat does not acknowledge its failed side thread.");
  await taskButton.click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.sidebar-agent-thread-button[title="Evidência — aviso de falha lido"]')
        ?.hasAttribute("data-attention"),
  );
  assert.equal(await taskButton.getAttribute("data-attention"), null);
  const original = await page.evaluate((input) => window.openbot.agent.listTasks(input), agentId);
  assert.equal(original.tasks.find((t) => t.id === taskId)?.outcome, "failed");
  checks.push("Opening the failed side thread dismisses its notification and preserves the failed outcome.");
  await page.getByRole("button", { name: "Tarefas", exact: true }).click();
  const card = page.locator(".tasks-page-row").filter({ hasText: "Evidência — aviso de falha lido" });
  await card.waitFor();
  assert.equal(await card.getAttribute("data-attention"), null);
  await page.screenshot({ path: resolve(out, "kanban-lido.png") });
  checks.push("The Kanban shares the same acknowledgement without opening the card again.");
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  await page.locator('[data-chat-id="chief"] > .agent-row').click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-loading").waitFor({ state: "hidden", timeout: 20000 });
  await page.getByRole("button", { name: "Tarefas", exact: true }).click();
  await card.waitFor();
  assert.equal(await card.getAttribute("data-attention"), null);
  checks.push("Acknowledgement survives renderer reload.");
  // The exact same error from a later turn is a new notification.
  fail(new Date().toISOString());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".app-loading").waitFor({ state: "hidden", timeout: 20000 });
  await page.getByRole("button", { name: "Tarefas", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tasks-page-row")].some(
      (e) =>
        e.textContent?.includes("Evidência — aviso de falha lido") && e.getAttribute("data-attention") === "failed",
    ),
  );
  await page.screenshot({ path: resolve(out, "nova-falha.png") });
  checks.push("A later failed turn with the same error produces a new notification.");
  await card.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tasks-page-row")].some(
      (e) => e.textContent?.includes("Evidência — aviso de falha lido") && !e.hasAttribute("data-attention"),
    ),
  );
  checks.push("Reading in the Kanban panel acknowledges the new failure.");
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  await page.locator('[data-chat-id="chief"] > .agent-row').click();
  await taskButton.waitFor();
  assert.equal(await taskButton.getAttribute("data-attention"), null);
  const host = await page.evaluate(() => window.openbot.agent.getRuntimeSnapshot());
  assert(!host?.failedTurns.some((t) => t.agentId === "chief"));
  await page.screenshot({ path: resolve(out, "lateral-lida.png") });
  checks.push("Sidebar reflects the Kanban read; Chief's real main-chat failure is acknowledged in the host runtime.");
  await page.evaluate(
    async (input) => {
      await window.openbot.agent.closeTask(input);
      await window.openbot.agent.reopenTask(input);
    },
    { agentId, taskId },
  );
  await page.getByRole("button", { name: "Tarefas", exact: true }).click();
  await card.waitFor();
  assert.equal(await card.getAttribute("data-attention"), null);
  checks.push("Archiving and restoring a read failure does not produce another notification.");
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (fixture) {
    await page.evaluate(
      async (input) => {
        await window.openbot.agent.closeTask(input);
        await window.openbot.agent.deleteTask(input);
      },
      { agentId: fixture.agentId, taskId: fixture.id },
    );
    // Remove only the presentation mark of this script's deleted fixture.
    await page.evaluate((id) => {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith("openbot:task-failure-reads:v1:")) continue;
        const reads = JSON.parse(localStorage.getItem(key) ?? "{}");
        delete reads[id];
        localStorage.setItem(key, JSON.stringify(reads));
      }
    }, fixture.id);
  }
  db.close();
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      { passed, failure, checks, url: page.url(), root: process.cwd(), instance: instance.instanceId },
      null,
      2,
    ),
  );
  await connection.close();
}
process.stdout.write(`${JSON.stringify({ passed, checks })}\n`);
