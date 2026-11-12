// Read-only production browser check: no account, code request, credential or personal browser profile.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const ORIGIN = "https://openbot.harpia.digital";
const OUT = resolve(import.meta.dirname, "../../../.openbot-build/vps-browser-e2e");
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const checks: { name: string; passed: boolean }[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "pt-BR" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  const response = await page.goto(`${ORIGIN}/app`);
  checks.push({ name: "the production web app responds over verified HTTPS", passed: response?.status() === 200 });
  await page.locator('input[type="email"]').click({ trial: true });
  checks.push({ name: "the real login UI hydrates and accepts pointer interaction", passed: true });
  await page
    .getByRole("status")
    .filter({ hasText: /Carregando o OpenBot|Loading OpenBot/ })
    .waitFor({ state: "hidden", timeout: 30_000 });
  await page.screenshot({ path: resolve(OUT, "login.png"), fullPage: true });
  checks.push({ name: "the login UI reports no browser script error", passed: errors.length === 0 });
} catch {
  checks.push({ name: "the production browser flow completes", passed: false });
} finally {
  await browser.close();
}
const passed = checks.every((check) => check.passed);
await writeFile(
  resolve(OUT, "report.json"),
  `${JSON.stringify({ origin: ORIGIN, passed, checks, limits: "Signed-out production web login only. No email was sent; no real user session or WebRTC transfer is claimed." }, null, 2)}\n`,
);
process.stdout.write(`${passed ? "PASS" : "FAIL"} production browser E2E (${checks.length} checks)\n`);
assert.ok(passed);
