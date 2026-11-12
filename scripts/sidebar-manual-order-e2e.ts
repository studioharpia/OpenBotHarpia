// Drives real sidebar drag events, preload, IPC and persisted layout in this checkout's dev app.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (r) => r.service === "app" && resolve(r.projectRoot) === resolve(process.cwd()),
);
assert(instance);
assertMutationAllowed({
  command: "sidebar-manual-order-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("sidebar-manual-order-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const { page } = connection;
page.setDefaultTimeout(8000);
const out = resolve(".openbot-build/sidebar-manual-order-e2e");
await mkdir(out, { recursive: true });
const original = await page.evaluate(() => window.openbot.agent.getSidebarLayout());
const ids = await page
  .locator("[data-chat-id]")
  .evaluateAll((es) => es.map((e) => e.getAttribute("data-chat-id")).filter((id): id is string => Boolean(id)));
assert(ids.length >= 3, "At least three visible chats required");
const sourceId = ids.at(-1);
const upwardTarget = ids[1];
const downwardTarget = ids.at(-2);
assert(sourceId && upwardTarget && downwardTarget);
const checks: string[] = [];
let passed = false;
try {
  await page.mouse.up();
  await page.keyboard.press("Escape");
  const drag = async (targetId: string, placement: "before" | "after") => {
    const before = await page
      .locator("[data-chat-id]")
      .evaluateAll((es) => es.map((e) => e.getAttribute("data-chat-id")));

    await page.locator(`[data-chat-id="${sourceId}"]`).scrollIntoViewIfNeeded();
    // The target's unshifted position is read after the empty pin target appears, before hovering.
    await page.evaluate((id) => {
      const source = document.querySelector<HTMLElement>(`[data-chat-id="${id}"]`);
      if (!source) throw new Error("Missing drag source");
      const box = source.getBoundingClientRect();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
          clientX: box.x + 30,
          clientY: box.y + 20,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
          clientX: box.x + 30,
          clientY: box.y + 21,
        }),
      );
    }, sourceId);
    await page.locator(".sidebar-pinned-empty-drop").waitFor();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.locator(`[data-chat-id="${targetId}"]`).scrollIntoViewIfNeeded();
    const point = await page.locator(`[data-chat-id="${targetId}"] > .agent-row`).evaluate((e) => {
      const box = e.getBoundingClientRect();
      return { x: box.x + 30, y: box.y + box.height / 2 };
    });
    await page.evaluate(
      ({ x, y }) =>
        document.querySelector(".agent-list")?.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer(),
            clientX: x,
            clientY: y,
          }),
        ),
      point,
    );
    // Wait for a real drag target calculation, ensuring the drop remeasurement sees the preview.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await page.evaluate(
      ({ x, y }) =>
        document.querySelector(".agent-list")?.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer(),
            clientX: x,
            clientY: y,
          }),
        ),
      point,
    );
    const expected = before.filter((id) => id !== sourceId);
    expected.splice(expected.indexOf(targetId) + (placement === "after" ? 1 : 0), 0, sourceId);
    await page.waitForFunction(
      (expected) =>
        expected.every(
          (id, index) => [...document.querySelectorAll("[data-chat-id]")][index]?.getAttribute("data-chat-id") === id,
        ),
      expected,
      { timeout: 8000 },
    );
    assert.deepEqual(
      await page.locator("[data-chat-id]").evaluateAll((es) => es.map((e) => e.getAttribute("data-chat-id"))),
      expected,
    );
    return expected;
  };
  const expected = await drag(upwardTarget, "before");
  checks.push("Arrastar para cima respeita a posição indicada mesmo com prévia animada e tarefas abaixo do agente.");
  await page.waitForFunction(() => !document.querySelector(".agent-list")?.hasAttribute("data-sidebar-dragging"));
  await page.screenshot({ path: resolve(out, "ordenacao.png") });
  await page.reload();
  await page.locator(`[data-chat-id="${sourceId}"]`).waitFor();
  assert.deepEqual(
    await page.locator("[data-chat-id]").evaluateAll((es) => es.map((e) => e.getAttribute("data-chat-id"))),
    expected,
  );
  checks.push("A ordem permanece após recarregar o app de desenvolvimento.");
  await drag(downwardTarget, "after");
  checks.push("Arrastar para baixo permite desfazer a movimentação.");
  passed = true;
} finally {
  await page.mouse.up();
  await page.keyboard.press("Escape");
  // Restore the original visible ordering without editing any conversations or tasks.
  for (const id of [...ids].reverse()) {
    const sectionId = original.agentAssignments[id] ?? null;
    const next =
      ids
        .slice(ids.indexOf(id) + 1)
        .find((candidate) => (original.agentAssignments[candidate] ?? null) === sectionId) ?? null;
    await page.evaluate((action) => window.openbot.agent.mutateSidebarLayout(action), {
      type: "move-agent" as const,
      agentId: id,
      sectionId,
      beforeAgentId: next,
    });
  }
  await writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      {
        passed,
        checks,
        environment: page.url(),
        fixture: "Existing dev chats; original visible ordering restored. No installed app changed.",
        limitation:
          "Post-fix drag events dispatched through DOM; initial reproduction also used native mouse dragging.",
      },
      null,
      2,
    ),
  );
  await connection.close();
}
