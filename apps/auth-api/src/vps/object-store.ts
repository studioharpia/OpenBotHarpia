import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const StoredMetadata = Schema.Struct({
  key: Schema.String,
  version: Schema.String,
  size: Schema.Number,
  etag: Schema.String,
  uploaded: Schema.Number,
  metadata: Schema.String,
  custom: Schema.String,
  storage_class: Schema.String,
});
type StoredMetadata = typeof StoredMetadata.Type;
const StoredRow = Schema.Struct({ ...StoredMetadata.fields, body: Schema.Uint8Array });
type StoredRow = typeof StoredRow.Type;
const HttpMetadata = Schema.Struct({
  contentType: Schema.optionalKey(Schema.String),
  contentLanguage: Schema.optionalKey(Schema.String),
  contentDisposition: Schema.optionalKey(Schema.String),
  contentEncoding: Schema.optionalKey(Schema.String),
  cacheControl: Schema.optionalKey(Schema.String),
  cacheExpiry: Schema.optionalKey(Schema.String),
});
const CustomMetadata = Schema.Record(Schema.String, Schema.String);
const MultipartOptions = Schema.Struct({
  httpMetadata: HttpMetadata,
  customMetadata: Schema.optionalKey(CustomMetadata),
  storageClass: Schema.optionalKey(Schema.String),
});
type ObjectValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

function storedHttpMetadata(value: typeof HttpMetadata.Type): R2HTTPMetadata {
  const { cacheExpiry, ...fields } = value;
  if (cacheExpiry === undefined) return fields;
  const expiry = new Date(cacheExpiry);
  if (Number.isNaN(expiry.getTime())) throw new Error("Invalid stored object expiration.");
  return { ...fields, cacheExpiry: expiry };
}

async function bytes(value: ObjectValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function metadata(value?: R2HTTPMetadata | Headers): R2HTTPMetadata {
  if (!(value instanceof Headers)) return value ?? {};
  const read = (key: string) => value.get(key) ?? undefined;
  const expires = value.get("Expires");
  return {
    contentType: read("Content-Type"),
    contentLanguage: read("Content-Language"),
    contentDisposition: read("Content-Disposition"),
    contentEncoding: read("Content-Encoding"),
    cacheControl: read("Cache-Control"),
    ...(expires ? { cacheExpiry: new Date(expires) } : {}),
  };
}

function conditions(value?: R2Conditional | Headers): R2Conditional {
  if (!(value instanceof Headers)) return value ?? {};
  const before = value.get("If-Unmodified-Since");
  const after = value.get("If-Modified-Since");
  return {
    etagMatches: value.get("If-Match") ?? undefined,
    etagDoesNotMatch: value.get("If-None-Match") ?? undefined,
    ...(before ? { uploadedBefore: new Date(before) } : {}),
    ...(after ? { uploadedAfter: new Date(after) } : {}),
    secondsGranularity: true,
  };
}

function matches(row: StoredMetadata | null, value?: R2Conditional | Headers): boolean {
  const condition = conditions(value);
  const etagMatches = (list: string) =>
    row !== null &&
    list
      .split(",")
      .some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//u, "").replace(/^"|"$/gu, "") === row.etag);
  if (condition.etagMatches && !etagMatches(condition.etagMatches)) return false;
  if (condition.etagDoesNotMatch && etagMatches(condition.etagDoesNotMatch)) return false;
  if (!row) return true;
  const precision = condition.secondsGranularity ? 1_000 : 1;
  const uploaded = Math.floor(row.uploaded / precision);
  if (condition.uploadedBefore && uploaded > Math.floor(condition.uploadedBefore.getTime() / precision)) return false;
  if (condition.uploadedAfter && uploaded <= Math.floor(condition.uploadedAfter.getTime() / precision)) return false;
  return true;
}

class StoredObject implements R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: R2HTTPMetadata;
  readonly customMetadata: Record<string, string>;
  readonly checksums: R2Checksums;
  readonly storageClass: string;

  constructor(
    row: StoredMetadata,
    readonly range?: R2Range,
  ) {
    this.key = row.key;
    this.version = row.version;
    this.size = row.size;
    this.etag = row.etag;
    this.httpEtag = `"${row.etag}"`;
    this.uploaded = new Date(row.uploaded);
    const parsed = Schema.decodeUnknownSync(HttpMetadata)(JSON.parse(row.metadata));
    this.httpMetadata = storedHttpMetadata(parsed);
    this.customMetadata = Schema.decodeUnknownSync(CustomMetadata)(JSON.parse(row.custom));
    this.storageClass = row.storage_class;
    const digest = Uint8Array.from(Buffer.from(row.etag, "hex")).buffer;
    this.checksums = { md5: digest, toJSON: () => ({ md5: row.etag }) };
  }

  writeHttpMetadata(headers: Headers): void {
    const mappings = [
      ["contentType", "Content-Type"],
      ["contentLanguage", "Content-Language"],
      ["contentDisposition", "Content-Disposition"],
      ["contentEncoding", "Content-Encoding"],
      ["cacheControl", "Cache-Control"],
    ] as const;
    for (const [key, header] of mappings) {
      const value = this.httpMetadata[key];
      if (value !== undefined) headers.set(header, value);
    }
    if (this.httpMetadata.cacheExpiry) headers.set("Expires", this.httpMetadata.cacheExpiry.toUTCString());
  }
}

class StoredBody extends StoredObject implements R2ObjectBody {
  readonly #response: Response;
  constructor(row: StoredRow, range?: R2Range) {
    super(row, range);
    const offset =
      range && "suffix" in range
        ? Math.max(0, row.body.length - range.suffix)
        : range && "offset" in range
          ? (range.offset ?? 0)
          : 0;
    const length = range && "length" in range ? (range.length ?? row.body.length) : row.body.length;
    this.#response = new Response(Uint8Array.from(row.body.subarray(offset, offset + length)));
  }
  get body(): ReadableStream {
    const body = this.#response.body;
    if (!body) throw new Error("Stored object body is unavailable.");
    return body;
  }
  get bodyUsed(): boolean {
    return this.#response.bodyUsed;
  }
  arrayBuffer(): Promise<ArrayBuffer> {
    return this.#response.arrayBuffer();
  }
  bytes(): Promise<Uint8Array> {
    return this.#response.bytes();
  }
  text(): Promise<string> {
    return this.#response.text();
  }
  json<T>(): Promise<T> {
    return this.#response.json();
  }
  blob(): Promise<Blob> {
    return this.#response.blob();
  }
}

function objectRange(value?: R2Range | Headers): R2Range | undefined {
  if (!(value instanceof Headers)) return value;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.get("Range") ?? "");
  if (!match) return undefined;
  if (!match[1]) return { suffix: Number(match[2]) };
  const offset = Number(match[1]);
  return { offset, ...(match[2] ? { length: Number(match[2]) - offset + 1 } : {}) };
}

/** Durable bucket adapter. Object content and metadata commit together in the VPS's own SQLite database. */
export class VpsObjectStore implements R2Bucket {
  readonly #database: DatabaseSync;
  constructor(
    path: string,
    private readonly bucket: string,
  ) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS objects(bucket TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL,
        body BLOB NOT NULL, etag TEXT NOT NULL, uploaded INTEGER NOT NULL, metadata TEXT NOT NULL,
        custom TEXT NOT NULL, storage_class TEXT NOT NULL, PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS uploads(bucket TEXT NOT NULL, key TEXT NOT NULL, upload_id TEXT PRIMARY KEY,
        options TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parts(upload_id TEXT NOT NULL REFERENCES uploads(upload_id) ON DELETE CASCADE, part INTEGER NOT NULL, body BLOB NOT NULL,
        etag TEXT NOT NULL, PRIMARY KEY(upload_id,part));`);
  }
  close(): void {
    this.#database.close();
  }
  #read(key: string): StoredRow | null {
    const row = this.#database
      .prepare(
        "SELECT key,version,length(body) AS size,body,etag,uploaded,metadata,custom,storage_class FROM objects WHERE bucket=? AND key=?",
      )
      .get(this.bucket, key);
    return row ? Schema.decodeUnknownSync(StoredRow)(row) : null;
  }
  #metadata(key: string): StoredMetadata | null {
    const row = this.#database
      .prepare(
        "SELECT key,version,length(body) AS size,etag,uploaded,metadata,custom,storage_class FROM objects WHERE bucket=? AND key=?",
      )
      .get(this.bucket, key);
    return row ? Schema.decodeUnknownSync(StoredMetadata)(row) : null;
  }
  async head(key: string): Promise<R2Object | null> {
    const row = this.#metadata(key);
    return row ? new StoredObject(row) : null;
  }
  get(
    key: string,
    options: R2GetOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2ObjectBody | R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    if (options?.ssecKey) throw new Error("Object encryption keys are not configured for this storage backend.");
    const row = this.#read(key);
    if (!row) return null;
    return matches(row, options?.onlyIf) ? new StoredBody(row, objectRange(options?.range)) : new StoredObject(row);
  }
  put(
    key: string,
    value: ObjectValue,
    options: R2PutOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2Object | null>;
  put(key: string, value: ObjectValue, options?: R2PutOptions): Promise<R2Object>;
  async put(key: string, value: ObjectValue, options: R2PutOptions = {}): Promise<R2Object | null> {
    if (options.ssecKey) throw new Error("Object encryption keys are not configured for this storage backend.");
    const body = await bytes(value);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const object = this.#writeObject(key, body, options);
      this.#database.exec("COMMIT");
      return object;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  #writeObject(key: string, body: Uint8Array, options: R2PutOptions): R2Object | null {
    if (!matches(this.#metadata(key), options.onlyIf)) return null;
    for (const algorithm of ["md5", "sha1", "sha256", "sha384", "sha512"] as const) {
      const expected = options[algorithm];
      if (expected === undefined) continue;
      const digest = createHash(algorithm).update(body).digest();
      const supplied =
        typeof expected === "string"
          ? Buffer.from(expected, "hex")
          : expected instanceof ArrayBuffer
            ? Buffer.from(expected)
            : Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
      if (!digest.equals(supplied)) throw new Error("Object checksum mismatch.");
    }
    const row: StoredRow = {
      key,
      body,
      size: body.length,
      version: randomUUID(),
      etag: createHash("md5").update(body).digest("hex"),
      uploaded: Date.now(),
      metadata: JSON.stringify(metadata(options.httpMetadata)),
      custom: JSON.stringify(options.customMetadata ?? {}),
      storage_class: options.storageClass ?? "STANDARD",
    };
    this.#database
      .prepare(
        "INSERT INTO objects(bucket,key,version,body,etag,uploaded,metadata,custom,storage_class) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET version=excluded.version,body=excluded.body,etag=excluded.etag,uploaded=excluded.uploaded,metadata=excluded.metadata,custom=excluded.custom,storage_class=excluded.storage_class",
      )
      .run(
        this.bucket,
        row.key,
        row.version,
        row.body,
        row.etag,
        row.uploaded,
        row.metadata,
        row.custom,
        row.storage_class,
      );
    return new StoredObject(row);
  }

  async delete(keys: string | string[]): Promise<void> {
    const remove = this.#database.prepare("DELETE FROM objects WHERE bucket=? AND key=?");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const key of typeof keys === "string" ? [keys] : keys) remove.run(this.bucket, key);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const prefix = options.prefix ?? "";
    const after = options.cursor
      ? Buffer.from(options.cursor, "base64url").toString("utf8")
      : (options.startAfter ?? "");
    const limit = Math.min(1_000, Math.max(1, options.limit ?? 1_000));
    const rows = this.#database
      .prepare(
        "SELECT key,version,length(body) AS size,etag,uploaded,metadata,custom,storage_class FROM objects WHERE bucket=? AND key>? AND substr(key,1,length(?))=? ORDER BY key LIMIT ?",
      )
      .all(this.bucket, after, prefix, prefix, limit + 1)
      .map((row) => Schema.decodeUnknownSync(StoredMetadata)(row));
    const page = rows.slice(0, limit);
    const prefixes = new Set<string>();
    const objects = page
      .filter((row) => {
        const index = options.delimiter ? row.key.indexOf(options.delimiter, prefix.length) : -1;
        if (index < 0) return true;
        prefixes.add(row.key.slice(0, index + (options.delimiter?.length ?? 0)));
        return false;
      })
      .map((row) => new StoredObject(row));
    const last = page.at(-1);
    return rows.length > limit && last
      ? {
          objects,
          delimitedPrefixes: [...prefixes],
          truncated: true,
          cursor: Buffer.from(last.key).toString("base64url"),
        }
      : { objects, delimitedPrefixes: [...prefixes], truncated: false };
  }
  async createMultipartUpload(key: string, options: R2MultipartOptions = {}): Promise<R2MultipartUpload> {
    if (options.ssecKey) throw new Error("Object encryption keys are not configured for this storage backend.");
    const uploadId = randomUUID();
    this.#database.prepare("INSERT INTO uploads(bucket,key,upload_id,options) VALUES(?,?,?,?)").run(
      this.bucket,
      key,
      uploadId,
      JSON.stringify({
        httpMetadata: metadata(options.httpMetadata),
        customMetadata: options.customMetadata,
        storageClass: options.storageClass,
      }),
    );
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    const load = () => {
      const upload = this.#database
        .prepare("SELECT options FROM uploads WHERE bucket=? AND key=? AND upload_id=?")
        .get(this.bucket, key, uploadId);
      if (!upload || typeof upload.options !== "string") throw new Error("Multipart upload is unavailable.");
      return upload.options;
    };
    const remove = () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.prepare("DELETE FROM parts WHERE upload_id=?").run(uploadId);
        this.#database
          .prepare("DELETE FROM uploads WHERE bucket=? AND key=? AND upload_id=?")
          .run(this.bucket, key, uploadId);
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value, options) => {
        load();
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || options?.ssecKey)
          throw new Error("Invalid multipart part.");
        const body = await bytes(value);
        load();
        const etag = createHash("md5").update(body).digest("hex");
        this.#database
          .prepare(
            "INSERT INTO parts(upload_id,part,body,etag) VALUES(?,?,?,?) ON CONFLICT(upload_id,part) DO UPDATE SET body=excluded.body,etag=excluded.etag",
          )
          .run(uploadId, partNumber, body, etag);
        return { partNumber, etag };
      },
      abort: async () => {
        load();
        remove();
      },
      complete: async (parts) => {
        const raw = Schema.decodeUnknownSync(MultipartOptions)(JSON.parse(load()));
        const httpMetadata = storedHttpMetadata(raw.httpMetadata);
        const customMetadata = raw.customMetadata ?? {};
        const values: Uint8Array[] = [];
        let previous = 0;
        for (const part of parts) {
          if (part.partNumber <= previous) throw new Error("Multipart parts must be ordered.");
          const row = this.#database
            .prepare("SELECT body,etag FROM parts WHERE upload_id=? AND part=?")
            .get(uploadId, part.partNumber);
          if (!row || !(row.body instanceof Uint8Array) || row.etag !== part.etag)
            throw new Error("Multipart part is unavailable.");
          values.push(row.body);
          previous = part.partNumber;
        }
        if (!values.length) throw new Error("Multipart upload has no parts.");
        this.#database.exec("BEGIN IMMEDIATE");
        try {
          load();
          const result = this.#writeObject(key, Buffer.concat(values), {
            httpMetadata,
            customMetadata,
            storageClass: raw.storageClass,
          });
          if (!result) throw new Error("Multipart object could not be completed.");
          this.#database
            .prepare("DELETE FROM uploads WHERE bucket=? AND key=? AND upload_id=?")
            .run(this.bucket, key, uploadId);
          this.#database.exec("COMMIT");
          return result;
        } catch (error) {
          this.#database.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }
}
