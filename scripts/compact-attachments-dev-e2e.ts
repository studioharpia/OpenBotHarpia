// Exercises the real dev renderer, preload, attachment storage and viewer. Only the local ACP
// provider is a fixture; it performs no external calls. Own temporary agent/provider are removed.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { strToU8, zipSync } from "fflate";
import { assertMutationAllowed, connectToDevApp } from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const instance = readDevInstanceRecords().find(
  (record) => record.service === "app" && resolve(record.projectRoot) === process.cwd(),
);
assert(instance, "Start this checkout's dev app first.");
assert.match(instance.profile, /^OpenBot Dev(?: wt-| \d+$)/);
assertMutationAllowed({
  command: "compact-attachments-dev-e2e",
  allowMutations: process.argv.includes("--allow-mutations"),
  instanceNamed: true,
  target: instance.instanceId,
});
const connection = await connectToDevApp(
  instance.remoteDebuggingPort,
  createOpenBotLogger("compact-attachments-dev-e2e"),
  { expectedRendererPort: instance.rendererPort, ownerPid: instance.pid },
);
const { page } = connection;
page.setDefaultTimeout(20_000);
const output = resolve(".openbot-build/anexos-compactos");
const evidence = resolve("specs/evidencias/anexos-compactos");
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const providerId = "compact-attachments-e2e";
const checks: string[] = [];
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let agentId: string | undefined;
const dimensions: { name: string; naturalWidth: number; naturalHeight: number; width: number; height: number }[] = [];
const report = {
  passed: false,
  url: page.url(),
  profile: instance.profile,
  checks,
  errors,
  error: "",
  dimensions,
};
try {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Agentes", exact: true }).waitFor();
  const fake = resolve(output, "provider.ts");
  await writeFile(
    fake,
    `import { serveFakeAcpAgent } from ${JSON.stringify(resolve("scripts/provider-fakes/acp-agent.ts"))};
let count=0;
serveFakeAcpAgent({
 initialize:(r,p)=>p.reply(r,{protocolVersion:1,agentInfo:{name:"attachments-fixture",version:"1"},agentCapabilities:{loadSession:true},authMethods:[]}),
 "session/new":(r,p)=>p.reply(r,{sessionId:"attachments-"+(++count),models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),
 "session/load":(r,p)=>p.reply(r,{models:{availableModels:[{modelId:"default",name:"Default"}],currentModelId:"default"}}),
 "session/prompt":(r,p)=>{p.say(r.params.sessionId,"Anexos recebidos para conferência visual.");p.reply(r,{stopReason:"end_turn"});}
});`,
  );
  await page.evaluate(
    async ({ providerId, fake, command }) => {
      await window.openbot.customAgents.save({
        id: providerId,
        name: "Attachments fixture",
        command,
        args: [fake],
        env: [],
        usagePrompt: null,
      });
    },
    { providerId, fake, command: process.execPath },
  );
  await page.evaluate(async () => window.openbot.refreshAgentProviders({ automatic: false }));
  await page.waitForFunction(async (id) => {
    const status = await window.openbot.agent.getStatus();
    return (
      (status.providers ?? []).some(
        (provider) =>
          provider.id === "acp" && provider.state === "available" && provider.connectionState !== "connecting",
      ) && (await window.openbot.agent.listModels()).some((model) => model.id === `${id}/default`)
    );
  }, providerId);
  const agent = await page.evaluate(
    async (id) =>
      window.openbot.agent.createAgent({
        name: "Evidência — anexos compactos",
        description: "Conferência temporária de anexos",
        avatarSeed: "attachments",
        avatarHue: null,
        initialMessage: "Preparar conferência de anexos.",
        provider: "acp",
        model: `${id}/default`,
      }),
    providerId,
  );
  agentId = agent.id;
  await page.waitForFunction(async (id) => !(await window.openbot.agent.readConversation(id)).activeTurnId, agentId);
  await page.getByRole("button", { name: "Agentes", exact: true }).click();
  await page.locator(`[data-chat-id="${agentId}"] > .agent-row`).click();
  const closePanel = page.getByRole("button", { name: "Fechar painel lateral", exact: true });
  if (await closePanel.count()) await closePanel.click();
  await page.evaluate(async (id) => {
    const images = [
      { name: "paisagem.png", width: 960, height: 540, color: "#cf7535" },
      { name: "retrato.png", width: 300, height: 900, color: "#358985" },
      { name: "panorama.png", width: 2400, height: 240, color: "#6855a8" },
    ];
    const data = images.map(({ name, width, height, color }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      ctx.font = `${Math.min(width, height) / 9}px sans-serif`;
      ctx.fillText(`${width} × ${height}`, Math.min(width, height) / 10, Math.min(width, height) / 3);
      const encoded = atob(canvas.toDataURL("image/png").split(",")[1] ?? "");
      return { name, mimeType: "image/png", bytes: Uint8Array.from(encoded, (character) => character.charCodeAt(0)) };
    });
    const drafts = await window.openbot.agent.importAttachmentData(data);
    await window.openbot.agent.sendMessage({
      agentId: id,
      text: "Imagens de teste: paisagem, retrato e panorama.",
      attachmentDraftIds: drafts.map((item) => item.id),
      clientMessageId: crypto.randomUUID(),
    });
  }, agentId);
  await page.waitForFunction(async (id) => !(await window.openbot.agent.readConversation(id)).activeTurnId, agentId);
  await page.evaluate(async (id) => {
    const snapshot = await window.openbot.agent.readConversation(id);
    const source = snapshot.messages
      .flatMap((message) => message.attachments ?? [])
      .find((file) => file.name === "retrato.png");
    if (!source?.previewUrl) throw new Error("Missing portrait preview URL");
    const bytes = new Uint8Array(await (await fetch(source.previewUrl)).arrayBuffer());
    const drafts = await window.openbot.agent.importAttachmentData([
      { name: "imagem-individual.png", mimeType: "image/png", bytes },
    ]);
    await window.openbot.agent.sendMessage({
      agentId: id,
      text: "Imagem individual na proporção original.",
      attachmentDraftIds: drafts.map((item) => item.id),
      clientMessageId: crypto.randomUUID(),
    });
  }, agentId);
  await page.waitForFunction(async (id) => !(await window.openbot.agent.readConversation(id)).activeTurnId, agentId);
  // Small valid files keep this operational test independent of Storybook's Vite assets and
  // of showcase links, which can name files that the seed did not place on this host.
  const pdfStream = "BT /F1 18 Tf 24 150 Td (Attachment preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${pdfStream.length} >>\nstream\n${pdfStream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReference = pdf.length;
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${crossReference}\n%%EOF\n`;
  const audioBytes = new Uint8Array(417 * 40);
  for (let index = 0; index < 40; index++) audioBytes.set([0xff, 0xfb, 0x90, 0x00], index * 417);
  const workbook = zipSync({
    "xl/workbook.xml": strToU8(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attachments" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Attachment preview</t></is></c></row></sheetData></worksheet>',
    ),
  });
  const fixtures = [
    { name: "invoice-2026-09.pdf", mimeType: "application/pdf", bytes: Array.from(strToU8(pdf)) },
    { name: "standup-recap.mp3", mimeType: "audio/mpeg", bytes: Array.from(audioBytes) },
    {
      name: "operating-plan.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: Array.from(workbook),
    },
  ];
  fixtures.push({
    name: "observacoes.md",
    mimeType: "text/markdown",
    bytes: Array.from(
      new TextEncoder().encode("# Conferência de anexos\n\nArquivo real de teste aberto pelo painel existente.\n"),
    ),
  });
  await page.evaluate(
    async ({ id, files }) => {
      const drafts = await window.openbot.agent.importAttachmentData(
        files.map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) })),
      );
      await window.openbot.agent.sendMessage({
        agentId: id,
        text: "Arquivos de teste: documento, áudio, planilha e Markdown.",
        attachmentDraftIds: drafts.map((item) => item.id),
        clientMessageId: crypto.randomUUID(),
      });
    },
    { id: agentId, files: fixtures },
  );
  await page.waitForFunction(async (id) => !(await window.openbot.agent.readConversation(id)).activeTurnId, agentId);
  checks.push("Imagens e arquivos importados e enviados pelo preload/IPC reais, com armazenamento no perfil dev.");
  const notifications = page.getByRole("button", { name: "Fechar notificação", exact: true });
  while (await notifications.count()) {
    const count = await notifications.count();
    await notifications.first().press("Enter");
    await page.waitForFunction(
      (previous) => document.querySelectorAll('[aria-label="Fechar notificação"]').length < previous,
      count,
    );
  }
  const gallery = page.getByRole("button", { name: "Visualizar paisagem.png", exact: true }).first();
  await gallery.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLImageElement>(".image-gallery-tile img")].length === 3 &&
      [...document.querySelectorAll<HTMLImageElement>(".image-gallery-tile img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
  );
  report.dimensions = await page.locator(".image-gallery-tile img").evaluateAll((images) =>
    images.flatMap((image) => {
      if (!(image instanceof HTMLImageElement)) return [];
      const box = image.getBoundingClientRect();
      return [
        {
          name: image.closest("button")?.getAttribute("aria-label") ?? "",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          width: box.width,
          height: box.height,
        },
      ];
    }),
  );
  await page.screenshot({ path: resolve(evidence, "01-conversa.png") });
  await page.getByRole("button", { name: "Visualizar observacoes.md", exact: true }).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidence, "01-arquivos.png") });
  await gallery.click();
  await page.getByRole("img", { name: "paisagem.png", exact: true }).waitFor();
  const viewer = page.locator(".image-lightbox");
  const zoom = viewer.locator(".image-lightbox-zoom-level");
  const originalZoom = await zoom.textContent();
  await viewer.getByRole("button", { name: "Ampliar", exact: true }).click();
  await page.waitForFunction(
    (original) => document.querySelector(".image-lightbox-zoom-level")?.textContent !== original,
    originalZoom,
  );
  await viewer.getByRole("button", { name: /ajustar à tela/ }).click();
  await viewer.getByRole("button", { name: "Próxima imagem", exact: true }).click();
  await page.getByRole("img", { name: "retrato.png", exact: true }).waitFor();
  await viewer.getByRole("button", { name: "Imagem anterior", exact: true }).click();
  await page.getByRole("img", { name: "paisagem.png", exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, "02-visualizador.png") });
  assert.equal(await viewer.getByRole("button", { name: "Baixar paisagem.png", exact: true }).isEnabled(), true);
  await viewer.getByRole("button", { name: "Fechar visualizador de imagens", exact: true }).click();
  await viewer.waitFor({ state: "hidden" });
  checks.push(
    "Clique abre o visualizador existente; zoom, ajuste, próxima/anterior e fechar funcionam; download permanece disponível.",
  );
  for (const name of ["retrato.png", "panorama.png", "imagem-individual.png"]) {
    await page
      .getByRole("button", { name: `Visualizar ${name}`, exact: true })
      .first()
      .click();
    await page.getByRole("img", { name, exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
  }
  checks.push("Retrato, panorama e imagem individual abrem pelo clique e fecham por Esc.");
  for (const name of ["observacoes.md", "invoice-2026-09.pdf", "operating-plan.xlsx"]) {
    const button = page.getByRole("button", { name: `Visualizar ${name}`, exact: true }).first();
    await button.click();
    await page.getByRole("complementary", { name: "Prévia do arquivo", exact: true }).waitFor();
    if (name === "observacoes.md")
      await page.getByRole("heading", { name: "Conferência de anexos", exact: true }).waitFor();
    await page.screenshot({ path: resolve(evidence, `03-arquivo-${name.replace(/[^a-z0-9]/gi, "-")}.png`) });
  }
  checks.push("Markdown, PDF e XLSX abrem no painel real de prévia.");
  const audio = page.locator("audio").first();
  await audio.scrollIntoViewIfNeeded();
  await audio.evaluate(async (element) => {
    if (!(element instanceof HTMLAudioElement)) throw new Error("Missing audio player");
    await element.play();
    element.pause();
  });
  assert.equal(
    await audio.evaluate((element) => {
      if (!(element instanceof HTMLAudioElement)) throw new Error("Missing audio player");
      return element.error;
    }),
    null,
  );
  checks.push("Áudio real carregou, reproduziu e pausou no controle existente.");
  await page.evaluate(async (id) => {
    const snapshot = await window.openbot.agent.readConversation(id);
    const image = snapshot.messages
      .flatMap((message) => message.attachments ?? [])
      .find((file) => file.name === "paisagem.png");
    if (!image) throw new Error("Missing stored image");
    if (!image.previewUrl) throw new Error("Missing stored preview URL");
    const response = await fetch(image.previewUrl);
    if (!response.ok || !(await response.arrayBuffer()).byteLength) throw new Error("Empty stored preview");
  }, agentId);
  checks.push("Prévia da imagem continua lendo bytes do armazenamento real.");
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  await page.screenshot({ path: resolve(evidence, "falha.png") }).catch(() => {});
} finally {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .evaluate(
      async ({ id, providerId }) => {
        if (id) {
          const snapshot = await window.openbot.agent.readConversation(id);
          if (snapshot.activeTurnId)
            await window.openbot.agent.interrupt({ agentId: id, turnId: snapshot.activeTurnId });
          await window.openbot.agent.deleteAgent(id);
        }
        await window.openbot.customAgents.delete({ id: providerId });
      },
      { id: agentId, providerId },
    )
    .catch((error: Error) => {
      report.error += ` Cleanup: ${error.message}`;
      report.passed = false;
      process.exitCode = 1;
    });
  await connection.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(resolve(evidence, "resultado.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
