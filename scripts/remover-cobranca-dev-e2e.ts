import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === process.cwd(),
);
assert(instance, "Inicie o dev deste checkout.");
assert(instance.profile.startsWith("OpenBot Dev wt-"), "Use o perfil isolado de desenvolvimento.");
assertMutationAllowed({
  command: "remover-cobranca-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const session = await connectToDevApp(instance.remoteDebuggingPort, createOpenBotLogger("remover-cobranca"), {
  expectedRendererPort: instance.rendererPort,
  ownerPid: instance.pid,
});
const { page } = session;
page.setDefaultTimeout(20_000);
const evidence = resolve("specs/evidencias/remover-cobranca");
await mkdir(evidence, { recursive: true });
const before = process.argv.includes("--before");
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.locator(".app-loading").waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.keyboard.press("Meta+Comma");
  const search = page.getByRole("searchbox", { name: /Pesquisar configurações|Search settings/ });
  await search.waitFor();
  await search.fill("");
  const billing = page.getByRole("tab", { name: /^(Cobrança|Billing)$/ });
  if (before) {
    await billing.click();
    await page.locator('[data-tab="billing"]').waitFor();
    await page.screenshot({ path: resolve(evidence, "antes.png") });
  } else {
    assert.equal(await billing.count(), 0);
    assert.equal(await page.locator('[data-tab="billing"]').count(), 0);
    checks.push("Menu e painel de Cobrança ausentes nas configurações integradas.");
    await page.getByRole("tab", { name: /^(Geral|General)$/ }).click();
    await page.locator('[data-tab="general"]').waitFor();
    await page.screenshot({ path: resolve(evidence, "depois.png") });
    for (const term of ["Cobrança", "Billing"]) {
      await search.fill(term);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[role="status"]')].some((element) => Boolean(element.textContent)),
      );
      assert.equal(await page.getByRole("button", { name: /^(Cobrança|Billing)( |$)/ }).count(), 0);
      checks.push(`Busca por ${term} não oferece a página removida.`);
    }
    await page.screenshot({ path: resolve(evidence, "busca.png") });
    await search.fill("");
    await page.getByRole("tab", { name: /^(Notificações|Notifications)$/ }).click();
    await page.locator('[data-tab="notifications"]').waitFor();
    await page.getByRole("tab", { name: /^(Geral|General)$/ }).click();
    await page.locator('[data-tab="general"]').waitFor();
    checks.push("Navegação Geral → Notificações → Geral preservada.");
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(evidence, "resultado.json"),
      JSON.stringify(
        {
          passed: true,
          url: page.url(),
          profile: instance.profile,
          viewport: page.viewportSize(),
          checks,
          errors,
        },
        null,
        2,
      ),
    );
  }
  process.stdout.write(`${JSON.stringify({ before, checks })}\n`);
} finally {
  await session.close();
}
