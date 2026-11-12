// Drives the real /join route through an existing Vite server, without real invitations or accounts.
// Run: bun scripts/join-page-e2e.ts [--base-url=http://127.0.0.1:3100]
// Writes a repeatable report and screenshots to .openbot-build/join-page-e2e/.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotInviteUrl, createWebAppInvitePath } from "@openbot/contracts/invite-links";
import { chromium } from "playwright-core";

const baseUrl =
  process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) ?? "http://127.0.0.1:3100";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Use a local development server.");
const output = resolve(import.meta.dirname, "../.openbot-build/join-page-e2e");
await mkdir(output, { recursive: true });
const checks: string[] = [];
const origin = new URL(baseUrl).origin;
const payload = {
  apiUrl: "https://api.openbot.run",
  serverId: "00000000-0000-4000-8000-000000000000",
  fingerprint: "A".repeat(43),
  token: "B".repeat(43),
};
const options = {};
const validUrl = new URL("/join", origin);
validUrl.search = new URLSearchParams({
  api: payload.apiUrl,
  server: payload.serverId,
  fingerprint: payload.fingerprint,
  invite: payload.token,
}).toString();
const expectedApp = createOpenBotInviteUrl(payload, options);
const expectedBrowser = createWebAppInvitePath(
  new URL(`${validUrl.pathname}${validUrl.search}`, "https://openbot.run").toString(),
  options,
);
const invalidMessage =
  "Este link de convite não é válido ou está incompleto. Peça um novo convite ao proprietário do servidor.";
const browser = await chromium.launch({ channel: "chrome", headless: true });
let passed = false;

try {
  for (const mode of ["normal", "disabled", "blocked"] as const) {
    const context = await browser.newContext({
      javaScriptEnabled: mode !== "disabled",
      viewport: { width: 1280, height: 900 },
      locale: "pt-BR",
    });
    try {
      let blockedScripts = 0;
      const errors: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (mode === "blocked" && route.request().resourceType() === "script") {
          blockedScripts += 1;
          return route.abort();
        }
        await route.continue();
      });
      const page = await context.newPage();
      page.on("pageerror", () => errors.push("JavaScriptError"));
      const visit = async (url: URL) => {
        const response = await page.goto(url.toString(), { waitUntil: "load" });
        assert.equal(response?.status(), 200);
      };
      const assertValid = async () => {
        const open = page.getByRole("link", { name: "Abrir OpenBot", exact: true });
        await open.waitFor({ state: "visible" });
        assert.equal(await open.getAttribute("href"), expectedApp);
        assert.equal(await open.isEnabled(), true);
        assert.equal(
          await page.getByRole("link", { name: "Entre por este navegador", exact: true }).getAttribute("href"),
          expectedBrowser,
        );
        assert.equal(await page.getByRole("alert").count(), 0);
      };

      await visit(validUrl);
      await page.screenshot({ path: resolve(output, `${mode}-initial.png`) });
      await assertValid();
      if (mode === "blocked") assert.ok(blockedScripts > 0, "The script failure must actually occur.");
      if (mode === "normal") assert.deepEqual(errors, []);
      checks.push(`${mode}: valid invitation has usable app and browser links with the exact payload`);
      await page.screenshot({ path: resolve(output, `${mode}-valid.png`) });

      const missing = new URL(validUrl);
      missing.searchParams.delete("invite");
      const malformed = new URL(validUrl);
      malformed.searchParams.set("invite", "invalid");
      const duplicate = new URL(validUrl);
      duplicate.searchParams.append("invite", payload.token);
      const foreign = new URL(validUrl);
      foreign.searchParams.set("api", "https://foreign.openbot.localhost");
      for (const [name, url] of [
        ["missing", missing],
        ["malformed", malformed],
        ["duplicate", duplicate],
        ["foreign", foreign],
      ] as const) {
        await visit(url);
        const error = page.getByRole("alert");
        await error.waitFor({ state: "visible" });
        assert.equal(await error.textContent(), invalidMessage);
        assert.equal(await page.getByRole("link", { name: "Abrir OpenBot", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Abrir OpenBot", exact: true }).count(), 0);
        checks.push(`${mode}: ${name} invitation shows a clear error without a stuck action`);
        if (name === "missing") await page.screenshot({ path: resolve(output, `${mode}-invalid.png`) });
      }
      await visit(validUrl);
      await assertValid();
      checks.push(`${mode}: a valid invitation works again after an invalid one`);

      // Exercise the browser action without opening the installed app or accepting an invitation.
      if (mode === "normal") {
        await page.getByRole("link", { name: "Entre por este navegador", exact: true }).click();
        await page.waitForURL((url) => url.pathname === "/app");
        await page.locator('input[type="email"]').waitFor({ state: "visible" });
        checks.push("normal: browser action reaches the real web sign-in without accepting an invitation");
      }
    } finally {
      await context.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  }
  passed = true;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, "report.json"),
    `${JSON.stringify(
      {
        passed,
        baseUrl,
        origin,
        fixtureOnly: true,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `${passed ? "Passed" : "Failed"}: ${checks.length} checks. Report: ${resolve(output, "report.json")}\n`,
  );
}
