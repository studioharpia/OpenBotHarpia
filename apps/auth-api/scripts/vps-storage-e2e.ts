// Exercises the VPS R2-compatible object store against a temporary persistent SQLite file.
// Run: bun apps/auth-api/scripts/vps-storage-e2e.ts
// The report contains scenario names and outcomes only; it does not include stored object data.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VpsObjectStore } from "../src/vps/object-store";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = join(ROOT, ".openbot-build", "vps-storage-e2e");
const checks: { name: string; passed: boolean; detail?: string }[] = [];

async function check(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function run(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vps-storage-e2e-"));
  const databasePath = join(temporaryRoot, "objects.sqlite");
  const primaryBucket = "vps-storage-e2e-primary";
  const secondaryBucket = "vps-storage-e2e-secondary";
  let store = new VpsObjectStore(databasePath, primaryBucket);

  try {
    await check("put, get and head preserve bytes, ETag and metadata", async () => {
      const uploaded = await store.put("docs/readme.txt", "durable object", {
        httpMetadata: {
          contentType: "text/plain; charset=utf-8",
          contentLanguage: "pt-BR",
          contentDisposition: "inline",
          contentEncoding: "identity",
          cacheControl: "private, max-age=60",
          cacheExpiry: new Date("2030-01-02T03:04:05.000Z"),
        },
        customMetadata: { owner: "e2e", purpose: "persistence" },
        storageClass: "STANDARD",
      });
      assert.equal(uploaded.size, 14);
      assert.equal(uploaded.etag.length, 32);
      const body = await store.get("docs/readme.txt");
      assert.ok(body);
      assert.equal(await body.text(), "durable object");
      assert.equal(body.etag, uploaded.etag);
      const head = await store.head("docs/readme.txt");
      assert.ok(head);
      assert.equal(head.version, uploaded.version);
      assert.deepEqual(head.customMetadata, { owner: "e2e", purpose: "persistence" });
      assert.ok(head.httpMetadata);
      assert.equal(head.httpMetadata.contentLanguage, "pt-BR");
      assert.ok(head.httpMetadata.cacheExpiry);
      assert.equal(head.httpMetadata.cacheExpiry.toISOString(), "2030-01-02T03:04:05.000Z");
      const headers = new Headers();
      head.writeHttpMetadata(headers);
      assert.equal(headers.get("Content-Type"), "text/plain; charset=utf-8");
      assert.equal(headers.get("Content-Language"), "pt-BR");
      assert.equal(headers.get("Content-Disposition"), "inline");
      assert.equal(headers.get("Content-Encoding"), "identity");
      assert.equal(headers.get("Cache-Control"), "private, max-age=60");
      assert.equal(headers.get("Expires"), "Wed, 02 Jan 2030 03:04:05 GMT");
    });

    await check("put and get honor ETag conditional requests", async () => {
      const current = await store.head("docs/readme.txt");
      assert.ok(current);
      const blocked = await store.put("docs/readme.txt", "must not overwrite", {
        onlyIf: { etagDoesNotMatch: current.etag },
      });
      assert.equal(blocked, null);
      const unchanged = await store.get("docs/readme.txt", { onlyIf: { etagDoesNotMatch: current.etag } });
      assert.ok(unchanged);
      assert.equal("body" in unchanged, false);
      const matched = await store.put("docs/readme.txt", "conditional update", {
        onlyIf: { etagMatches: current.httpEtag },
        httpMetadata: current.httpMetadata,
        customMetadata: current.customMetadata,
        storageClass: current.storageClass,
      });
      assert.ok(matched);
      assert.notEqual(matched.etag, current.etag);
      const stale = await store.put("docs/readme.txt", "stale update", {
        onlyIf: { etagMatches: current.etag },
      });
      assert.equal(stale, null);
      const conditionalHeaders = await store.get("docs/readme.txt", {
        onlyIf: new Headers({ "If-None-Match": matched.httpEtag }),
      });
      assert.ok(conditionalHeaders);
      assert.equal("body" in conditionalHeaders, false);
    });

    await check("get supports byte ranges and suffix ranges", async () => {
      await store.put("range.bin", "0123456789");
      const range = await store.get("range.bin", { range: { offset: 2, length: 4 } });
      const suffix = await store.get("range.bin", { range: { suffix: 3 } });
      assert.ok(range && suffix);
      assert.equal(await range.text(), "2345");
      assert.equal(await suffix.text(), "789");
      const headerRange = await store.get("range.bin", { range: new Headers({ Range: "bytes=4-6" }) });
      assert.ok(headerRange);
      assert.equal(await headerRange.text(), "456");
    });

    await check("list supports prefix, cursor pagination and startAfter", async () => {
      for (const key of ["pages/a", "pages/b", "pages/c", "pages/d", "other/a"]) {
        await store.put(key, key);
      }
      const first = await store.list({ prefix: "pages/", limit: 2 });
      assert.deepEqual(
        first.objects.map(({ key }) => key),
        ["pages/a", "pages/b"],
      );
      assert.equal(first.truncated, true);
      assert.ok(first.cursor);
      const second = await store.list({ prefix: "pages/", limit: 2, cursor: first.cursor });
      assert.deepEqual(
        second.objects.map(({ key }) => key),
        ["pages/c", "pages/d"],
      );
      assert.equal(second.truncated, false);
      const after = await store.list({ prefix: "pages/", startAfter: "pages/b", limit: 10 });
      assert.deepEqual(
        after.objects.map(({ key }) => key),
        ["pages/c", "pages/d"],
      );
    });

    await check("list matches Unicode prefixes and delimiter namespaces", async () => {
      const prefix = "🪴/資料/";
      await store.put(`${prefix}one`, "one");
      await store.put(`${prefix}nested/two`, "two");
      await store.put("🪴/資料-extra/three", "three");
      const listed = await store.list({ prefix, delimiter: "/", limit: 10 });
      assert.deepEqual(
        listed.objects.map(({ key }) => key),
        [`${prefix}one`],
      );
      assert.deepEqual(listed.delimitedPrefixes, [`${prefix}nested/`]);
    });

    await check("bucket namespaces isolate equal keys in the same database", async () => {
      const other = new VpsObjectStore(databasePath, secondaryBucket);
      try {
        await other.put("shared/key", "secondary bucket");
        await store.put("shared/key", "primary bucket");
        assert.equal(await (await store.get("shared/key"))?.text(), "primary bucket");
        assert.equal(await (await other.get("shared/key"))?.text(), "secondary bucket");
        assert.equal((await other.list({ prefix: "shared/" })).objects.length, 1);
      } finally {
        other.close();
      }
    });

    const multipartKey = "multipart/archive.bin";
    let uploadId = "";
    let firstPart = { partNumber: 1, etag: "" };
    await check("multipart upload and part metadata survive reopening", async () => {
      const upload = await store.createMultipartUpload(multipartKey, {
        httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" },
        customMetadata: { assembled: "true" },
        storageClass: "STANDARD",
      });
      uploadId = upload.uploadId;
      firstPart = await upload.uploadPart(1, "part-one");
      store.close();
      store = new VpsObjectStore(databasePath, primaryBucket);
      const resumed = store.resumeMultipartUpload(multipartKey, uploadId);
      const secondPart = await resumed.uploadPart(2, "part-two");
      const completed = await resumed.complete([firstPart, secondPart]);
      assert.equal(completed.size, 16);
      const object = await store.get(multipartKey);
      assert.ok(object);
      assert.equal(await object.text(), "part-onepart-two");
      assert.ok(object.httpMetadata);
      assert.equal(object.httpMetadata.contentType, "application/octet-stream");
      assert.equal(object.httpMetadata.cacheControl, "no-store");
      assert.deepEqual(object.customMetadata, { assembled: "true" });
    });

    await check("delete removes one or several namespaced objects", async () => {
      await store.put("delete/one", "1");
      await store.put("delete/two", "2");
      await store.delete("delete/one");
      assert.equal(await store.head("delete/one"), null);
      await store.delete(["delete/two", multipartKey]);
      assert.equal(await store.head("delete/two"), null);
      assert.equal(await store.head(multipartKey), null);
    });

    store.close();
    store = new VpsObjectStore(databasePath, primaryBucket);
    await check("stored content and metadata persist after a clean reopen", async () => {
      const object = await store.get("docs/readme.txt");
      assert.ok(object);
      assert.equal(await object.text(), "conditional update");
      assert.deepEqual(object.customMetadata, { owner: "e2e", purpose: "persistence" });
      assert.ok(await store.head("range.bin"));
      assert.equal(await store.head(multipartKey), null);
    });
  } finally {
    store.close();
    await writeFile(
      join(OUT, "report.json"),
      `${JSON.stringify({ finishedAt: new Date().toISOString(), checks }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const failures = checks.filter(({ passed }) => !passed);
  process.stdout.write(`${failures.length ? "FAIL" : "PASS"} VPS object storage E2E (${checks.length} checks)\n`);
  process.stdout.write(`Report: ${join(OUT, "report.json")}\n`);
  if (failures.length) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void run();
