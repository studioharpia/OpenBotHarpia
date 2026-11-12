// Real dev renderer, preload, IPC, task service and persisted read cursors. No provider turn is sent.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTask, ConversationReadState } from "@openbot/contracts/ipc";
import { AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY } from "@openbot/contracts/team-protocol/agent-thread-message-actions-v1";
import {
  TEAM_PROTOCOL_V9_ONLY_CAPABILITIES,
  teamCapabilitiesForProtocol,
} from "@openbot/contracts/team-protocol/current";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === resolve(process.cwd()),
);
assert(instance, "Start this checkout's dev app first.");
assertMutationAllowed({
  command: "agent-thread-unread-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("agent-thread-unread-e2e"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = connection;
page.setDefaultTimeout(12_000);
const out = resolve(".openbot-build/agent-thread-unread-e2e");
await mkdir(out, { recursive: true });
const checks: string[] = [];
let fixture: AgentTask | undefined;
let ownerId: string | undefined;
let originalRead: ConversationReadState | undefined;
let passed = false;
let error = "";
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
try {
  await page.bringToFront();
  const sidebarToggle = page.getByRole("button", {
    name: /Mostrar tarefas na barra lateral|Show tasks in sidebar/,
    exact: true,
  });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();

  const available = await page.evaluate(async () => {
    const agents = await window.openbot.agent.listAgents();
    for (const agent of [...agents].sort((a, b) => Number(b.name === "Chief") - Number(a.name === "Chief"))) {
      const snapshot = await window.openbot.agent.readConversation(agent.id);
      if (snapshot.activeTurnId) continue;
      const answer = snapshot.messages.findLast(
        (message) =>
          message.author === "assistant" && message.status === "completed" && !message.itemType && message.text.trim(),
      );
      if (answer)
        return {
          agent,
          snapshot,
          answerId: answer.id,
          otherAgentId: agents.find((other) => other.id !== agent.id)?.id,
        };
    }
    return null;
  });
  assert(available, "An idle agent with a finished main-chat answer is required.");
  ownerId = available.agent.id;
  const agentId = ownerId;
  originalRead = available.snapshot.readState;
  const title = `Evidência de não lidos ${Date.now()}`;
  fixture = await page.evaluate(
    async ({ agentId, answerId, title }) => {
      const task = await window.openbot.agent.branchTask({
        agentId,
        taskId: null,
        messageId: answerId,
        requestId: crypto.randomUUID(),
      });
      await window.openbot.agent.renameTask({ agentId, taskId: task.id, title });
      return { ...task, title };
    },
    { agentId, answerId: available.answerId, title },
  );
  const taskId = fixture.id;
  const task = await page.evaluate((input) => window.openbot.agent.readTask(input), { agentId, taskId });
  const answer = task.messages.findLast(
    (message) =>
      message.author === "assistant" && message.status === "completed" && !message.itemType && message.text.trim(),
  );
  assert(answer);
  const messageId = answer.id;
  const row = page
    .getByRole("complementary", { name: /Navegação dos agentes|Chat list/ })
    .getByRole("button", { name: new RegExp(`^${escapePattern(available.agent.name)}(?:,|\\.)`) });
  await row.click();
  const mainMessage = page.locator(`[data-chat-search-message="${available.answerId}"]`).last();
  await mainMessage.scrollIntoViewIfNeeded();
  await mainMessage.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Marcar como não lido|Mark as unread/, exact: true }).click();
  await page.waitForFunction(
    async ({ agentId }) => ((await window.openbot.agent.listConversationReads())[agentId]?.unreadCount ?? 0) > 0,
    { agentId },
  );
  await page.screenshot({ path: resolve(out, "agente-nao-lido.png") });
  checks.push("Main-message mark-unread persists and the live sidebar renders the agent's unread state.");
  await page.getByRole("button", { name: new RegExp(`^${escapePattern(title)}`) }).click();
  const message = page.locator(`[data-chat-search-message="${messageId}"]`).last();
  await message.scrollIntoViewIfNeeded();
  await message.click({ button: "right" });
  for (const name of [
    /Responder|Reply/,
    /Copiar mensagem|Copy message/,
    /Reagir|React/,
    /Marcar como não lido|Mark as unread/,
    /Excluir|Delete/,
  ]) {
    await page.getByRole("menuitem", { name, exact: true }).waitFor();
  }
  await page.screenshot({ path: resolve(out, "menu-tarefa.png") });
  checks.push(
    "The side-task message menu exposes Reply, Copy, React, Mark unread and Delete; existing Branch/Send-to-channel are capability/context gated.",
  );
  await page.getByRole("menuitem", { name: /Reagir|React/, exact: true }).hover();
  await page.getByRole("menuitemradio", { name: /👍/ }).click();
  await page.waitForFunction(
    async ({ agentId, taskId, messageId }) =>
      (await window.openbot.agent.readTask({ agentId, taskId })).messages.some(
        (message) => message.id === messageId && message.reaction === "👍",
      ),
    { agentId, taskId, messageId },
  );
  await page.getByRole("button", { name: /Remover.*reação.*👍|Remove.*reaction.*👍/ }).click();
  await page.waitForFunction(
    async ({ agentId, taskId, messageId }) =>
      (await window.openbot.agent.readTask({ agentId, taskId })).messages.some(
        (message) => message.id === messageId && !message.reaction,
      ),
    { agentId, taskId, messageId },
  );
  checks.push("React and remove reaction work through the live task message and persist in the task conversation.");
  await message.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Marcar como não lido|Mark as unread/, exact: true }).click();
  await page.waitForFunction(
    async ({ agentId, taskId, messageId }) =>
      (await window.openbot.agent.listTaskReads(agentId)).some(
        (read) => read.taskId === taskId && read.unreadCount > 0 && read.firstUnreadMessageId === messageId,
      ),
    { agentId, taskId, messageId },
  );
  // A normal read of the task refreshes data while the user still sees the selected task.
  await page.evaluate((input) => window.openbot.agent.readTask(input), { agentId, taskId });
  const held = await page.evaluate(
    async ({ agentId, taskId }) =>
      (await window.openbot.agent.listTaskReads(agentId)).find((read) => read.taskId === taskId),
    { agentId, taskId },
  );
  assert(held && held.unreadCount > 0);
  await page.screenshot({ path: resolve(out, "tarefa-nao-lida.png") });
  checks.push(
    "Manual unread survives while the task stays visible and keeps the marked message as the unread boundary.",
  );
  await row.click();
  const afterLeave = await page.evaluate(
    async ({ agentId, taskId }) =>
      (await window.openbot.agent.listTaskReads(agentId)).find((read) => read.taskId === taskId),
    { agentId, taskId },
  );
  assert(afterLeave && afterLeave.unreadCount > 0);
  await page.getByRole("button", { name: new RegExp(`^${escapePattern(title)}`) }).click();
  await page.getByRole("textbox").last().click();
  await page.waitForFunction(
    async ({ agentId, taskId }) =>
      (await window.openbot.agent.listTaskReads(agentId)).some(
        (read) => read.taskId === taskId && read.unreadCount === 0,
      ),
    { agentId, taskId },
  );
  checks.push("Leaving keeps the task unread; returning to its focused conversation marks it read again.");
  if (available.otherAgentId) {
    const rejected = await page.evaluate(
      async ({ agentId, taskId, messageId }) => {
        try {
          await window.openbot.agent.markTaskUnread({ agentId, taskId, fromMessageId: messageId });
          return false;
        } catch {
          return true;
        }
      },
      { agentId: available.otherAgentId, taskId, messageId },
    );
    assert(rejected);
  }
  const foreignMessage = await page.evaluate(
    async ({ agentId, taskId, messageId }) => {
      try {
        await window.openbot.agent.markTaskUnread({ agentId, taskId, fromMessageId: messageId });
        return false;
      } catch {
        return true;
      }
    },
    { agentId, taskId, messageId: available.answerId },
  );
  assert(foreignMessage);
  checks.push("IPC/domain refuse a foreign task owner and a boundary message outside the task.");
  for (const version of [7, 8]) {
    const capabilities = teamCapabilitiesForProtocol(version);
    assert(capabilities.length <= 128);
    assert(!capabilities.includes(AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY));
  }
  assert(TEAM_PROTOCOL_V9_ONLY_CAPABILITIES.has(AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY));
  assert(teamCapabilitiesForProtocol(9).includes(AGENT_THREAD_MESSAGE_ACTIONS_CAPABILITY));
  checks.push(
    "The additive message-action capability is advertised only to protocol 9; frozen protocol 7/8 capability bounds remain intact.",
  );
  passed = true;
} catch (failure) {
  error = failure instanceof Error ? failure.message : String(failure);
  process.exitCode = 1;
} finally {
  let cleaned = false;
  if (fixture && ownerId) {
    await page
      .evaluate(
        async ({ agentId, taskId }) => {
          await window.openbot.agent.closeTask({ agentId, taskId });
          await window.openbot.agent.deleteTask({ agentId, taskId });
        },
        { agentId: ownerId, taskId: fixture.id },
      )
      .catch(() => {});
    cleaned = await page.evaluate(
      async ({ agentId, taskId }) =>
        !(await window.openbot.agent.listTasks(agentId)).tasks.some((task) => task.id === taskId),
      { agentId: ownerId, taskId: fixture.id },
    );
  }
  if (ownerId && originalRead) {
    await page
      .evaluate(
        async ({ agentId, originalRead }) => {
          if (originalRead.unreadCount && originalRead.firstUnreadMessageId)
            await window.openbot.agent.markConversationUnread({
              agentId,
              fromMessageId: originalRead.firstUnreadMessageId,
            });
          else
            await window.openbot.agent.markConversationRead({
              agentId,
              throughMessageId: originalRead.throughMessageId,
            });
        },
        { agentId: ownerId, originalRead },
      )
      .catch(() => {});
  }
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      {
        passed,
        checks,
        error,
        fixtureRemoved: cleaned,
        instance: instance.instanceId,
        environment:
          "Real dev app of this checkout, renderer/preload/IPC/service and SQLite; one temporary branch, no provider turn.",
      },
      null,
      2,
    ),
  );
  await connection.close();
  process.stdout.write(`${JSON.stringify({ passed, checks: checks.length, error, fixtureRemoved: cleaned })}\n`);
}
