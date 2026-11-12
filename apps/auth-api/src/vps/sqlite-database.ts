import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";

const MIGRATION_TABLE = "vps_schema_migrations";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const TRANSACTION_STATEMENT =
  /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

interface LocalD1Meta {
  [key: string]: string | number | boolean;
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

type RawRow = SQLOutputValue[];
type SqliteRow = { [column: string]: SQLOutputValue };

/**
 * A persistent, single-process D1-compatible adapter for the VPS account service.
 * SQLite calls are synchronous at the driver boundary; async methods match the D1 SDK contract.
 */
export class VpsSqliteDatabase implements D1Database {
  readonly #database: DatabaseSync;
  readonly #bookmarkId = randomUUID();
  #revision = 0;
  #closed = false;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    this.#database.exec("PRAGMA journal_mode = WAL");
  }

  prepare(query: string): D1PreparedStatement {
    this.#assertOpen();
    return new SqlitePreparedStatement(this, query);
  }

  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  async batch(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    this.#assertOpen();
    const prepared = statements.map((statement) => {
      const source = statement instanceof SqliteSessionPreparedStatement ? statement.source : statement;
      if (!(source instanceof SqlitePreparedStatement) || source.database !== this) {
        throw new TypeError("A SQLite D1 batch can contain only statements prepared by this database.");
      }
      if (TRANSACTION_STATEMENT.test(source.query)) {
        throw new TypeError("Transaction control statements are not allowed in a SQLite D1 batch.");
      }
      return source;
    });

    const nested = this.#database.isTransaction;
    const savepoint = `d1_batch_${randomUUID().replaceAll("-", "")}`;
    this.#database.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const results: D1Result<unknown>[] = [];
      for (const statement of prepared) results.push(statement.executeAll());
      this.#database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return results;
    } catch (error) {
      try {
        this.#database.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      } catch {
        // Keep the original statement failure; a rollback failure cannot make it safer to continue.
      }
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.#assertOpen();
    const started = performance.now();
    const before = this.#totalChanges();
    this.#database.exec(query);
    const changes = this.#totalChanges() - before;
    if (changes > 0) this.#revision += 1;
    return {
      count: countSqlStatements(query),
      duration: performance.now() - started,
    };
  }

  /** @internal */
  execSyncForMigration(query: string): void {
    this.#assertOpen();
    this.#database.exec(query);
  }

  /** @internal */
  readMigrations(): { name: string; checksum: string }[] {
    this.#assertOpen();
    const rows = this.#database.prepare(`SELECT name, checksum FROM ${MIGRATION_TABLE} ORDER BY name`).all();
    return rows.map((row) => {
      if (!isSqliteRow(row) || typeof row.name !== "string" || typeof row.checksum !== "string") {
        throw new TypeError("The local migration table contains an invalid row.");
      }
      return { name: row.name, checksum: row.checksum };
    });
  }

  /** @internal */
  applyMigration(name: string, checksum: string, sql: string): void {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(sql);
      this.#database
        .prepare(`INSERT INTO ${MIGRATION_TABLE}(name, checksum, applied_at) VALUES (?, ?, ?)`)
        .run(name, checksum, Date.now());
      this.#database.exec("COMMIT");
      this.#revision += 1;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Keep the migration error. A later open will fail closed on the unchanged migration table.
      }
      throw error;
    }
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    this.#assertOpen();
    // SQLite has one authoritative connection and no replicas, so every session already reads
    // at least as new as any local bookmark. D1's constraint is therefore a no-op here.
    void constraintOrBookmark;
    let touched = false;
    return {
      prepare: (query) => new SqliteSessionPreparedStatement(this.prepare(query), () => (touched = true)),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        touched = true;
        return this.batch<T>(statements);
      },
      getBookmark: () => (touched ? `sqlite:${this.#bookmarkId}:${this.#revision}` : null),
    };
  }

  async dump(): Promise<ArrayBuffer> {
    this.#assertOpen();
    return Uint8Array.from(this.#database.serialize()).buffer;
  }

  /** Close the underlying file. The owner of this adapter controls its lifetime. */
  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  get revision(): number {
    return this.#revision;
  }

  /** @internal */
  _database(): DatabaseSync {
    this.#assertOpen();
    return this.#database;
  }

  /** @internal */
  _changed(): void {
    this.#revision += 1;
  }

  /** @internal */
  _totalChanges(): number {
    const row = this.#database.prepare("SELECT total_changes() AS changes").get();
    if (!isSqliteRow(row)) throw new TypeError("SQLite did not return the total changes counter.");
    return Number(row.changes);
  }

  /** @internal */
  _sizeAfter(): number {
    const pageCount = this.#database.prepare("PRAGMA page_count").get();
    const pageSize = this.#database.prepare("PRAGMA page_size").get();
    if (!isSqliteRow(pageCount) || !isSqliteRow(pageSize)) {
      throw new TypeError("SQLite did not return its database page size.");
    }
    const count = Number(pageCount.page_count);
    const size = Number(pageSize.page_size);
    const bytes = count * size;
    if (!Number.isSafeInteger(bytes) || count < 0 || size <= 0) {
      throw new RangeError("SQLite database size is outside the supported metadata range.");
    }
    return bytes;
  }

  /** @internal */
  _assertOpen(): void {
    this.#assertOpen();
  }

  #totalChanges(): number {
    return this._totalChanges();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The VPS SQLite database is closed.");
  }
}

class SqlitePreparedStatement implements D1PreparedStatement {
  readonly #statement: StatementSync;
  #values: SQLInputValue[] = [];

  constructor(
    readonly database: VpsSqliteDatabase,
    readonly query: string,
  ) {
    if (typeof query !== "string" || query.trim().length === 0) throw new TypeError("SQL query must not be empty.");
    this.#statement = database._database().prepare(query);
    // Node 24 can preserve duplicate result-column names as tuples. Older supported node:sqlite
    // versions still work; their object rows are converted to tuples by the raw methods below.
    this.#statement.setReturnArrays?.(true);
  }

  bind(...values: unknown[]): D1PreparedStatement {
    const copy = new SqlitePreparedStatement(this.database, this.query);
    copy.#values = values.map(toSqlInputValue);
    return copy;
  }

  first<T>(column: string): Promise<T | null>;
  first<T>(): Promise<T | null>;
  async first(column?: string): Promise<unknown | null> {
    return this.#execute(() => {
      const columns = this.#columns();
      const row = this.#statement.get(...this.#values);
      if (row === undefined) return { value: null, rowsRead: 0, changes: 0, lastRowId: 0 };
      const normalized = normalizeRow(row, columns);
      const value = column === undefined ? normalized : (normalized[column] ?? null);
      return { value, rowsRead: 1, changes: 0, lastRowId: this.#lastInsertRowId() };
    });
  }

  run<T>(): Promise<D1Result<T>>;
  async run(): Promise<D1Result<unknown>> {
    return this.#execute(() => {
      const started = performance.now();
      const result = this.#statement.run(...this.#values);
      const changes = Number(result.changes);
      if (changes > 0) this.database._changed();
      return {
        value: createResult([], changes, Number(result.lastInsertRowid), 0, started, this.database._sizeAfter()),
        rowsRead: 0,
        changes,
        lastRowId: Number(result.lastInsertRowid),
      };
    });
  }

  all<T>(): Promise<D1Result<T>>;
  async all(): Promise<D1Result<unknown>> {
    return this.executeAll();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw(options?: { columnNames?: boolean }): Promise<unknown> {
    return this.#execute(() => {
      const columns = this.#columns();
      const rows = this.#statement.all(...this.#values).map((row) => normalizeTuple(row, columns));
      const changes = Math.max(0, this.database._totalChanges() - this.#lastTotalChangesBeforeRead);
      const result = options?.columnNames ? [columns, ...rows] : rows;
      return { value: result, rowsRead: rows.length, changes, lastRowId: this.#lastInsertRowId() };
    });
  }

  executeAll(): D1Result<unknown> {
    this.database._assertOpen();
    const before = this.database._totalChanges();
    const started = performance.now();
    const columns = this.#columns();
    const rows = this.#statement.all(...this.#values).map((row) => normalizeRow(row, columns));
    const changes = Math.max(0, this.database._totalChanges() - before);
    if (changes > 0) this.database._changed();
    return createResult(rows, changes, this.#lastInsertRowId(), rows.length, started, this.database._sizeAfter());
  }

  getBindValues(): readonly SQLInputValue[] {
    return this.#values;
  }

  getTotalChangesBeforeRead(): number {
    return this.database._totalChanges();
  }

  #lastTotalChangesBeforeRead = 0;

  #execute<A>(operation: () => { value: A; rowsRead: number; changes: number; lastRowId: number }): A {
    this.database._assertOpen();
    const before = this.database._totalChanges();
    this.#lastTotalChangesBeforeRead = before;
    const outcome = operation();
    // Methods that report changes above already use the driver's direct change count. The total
    // delta catches RETURNING/side-effect statements executed through first() and raw().
    const totalDelta = Math.max(0, this.database._totalChanges() - before);
    if (outcome.changes === 0 && totalDelta > 0) this.database._changed();
    return outcome.value;
  }

  #columns(): string[] {
    return this.#statement.columns().map((column) => column.name);
  }

  #lastInsertRowId(): number {
    const row = this.database._database().prepare("SELECT last_insert_rowid() AS id").get();
    if (!isSqliteRow(row)) throw new TypeError("SQLite did not return the last inserted row ID.");
    return Number(row.id);
  }
}

class SqliteSessionPreparedStatement implements D1PreparedStatement {
  constructor(
    readonly source: D1PreparedStatement,
    readonly touch: () => void,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteSessionPreparedStatement(this.source.bind(...values), this.touch);
  }

  first<T>(column: string): Promise<T | null>;
  first<T>(): Promise<T | null>;
  first(column?: string): Promise<unknown | null> {
    this.touch();
    return column === undefined ? this.source.first() : this.source.first(column);
  }

  run<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>> {
    this.touch();
    return this.source.run();
  }

  all<T>(): Promise<D1Result<T>>;
  all(): Promise<D1Result<unknown>> {
    this.touch();
    return this.source.all();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw(options?: { columnNames?: boolean }): Promise<unknown> {
    this.touch();
    if (options?.columnNames === true) return this.source.raw({ columnNames: true });
    if (options?.columnNames === false) return this.source.raw({ columnNames: false });
    return this.source.raw();
  }
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("SQLite bindings must use finite numbers.");
    return value;
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("SQLite bindings accept only null, booleans, finite numbers, bigint, strings, and bytes.");
}

function normalizeRow(row: unknown, columns: readonly string[]): SqliteRow {
  if (Array.isArray(row)) {
    const result: SqliteRow = {};
    for (const [index, column] of columns.entries()) {
      const value = row[index];
      if (isSqliteOutputValue(value)) result[column] = value;
    }
    return result;
  }
  if (isSqliteRow(row)) return row;
  throw new TypeError("SQLite returned a row in an unsupported shape.");
}

function normalizeTuple(row: unknown, columns: readonly string[]): RawRow {
  if (Array.isArray(row)) {
    if (!row.every(isSqliteOutputValue)) throw new TypeError("SQLite returned an invalid tuple value.");
    return row;
  }
  if (isSqliteRow(row)) return columns.map((column) => row[column] ?? null);
  throw new TypeError("SQLite returned a row in an unsupported shape.");
}

function isSqliteOutputValue(value: unknown): value is SQLOutputValue {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "string" ||
    value instanceof Uint8Array
  );
}

function isSqliteRow(value: unknown): value is SqliteRow {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isSqliteOutputValue)
  );
}

function createResult<T>(
  results: T[],
  changes: number,
  lastRowId: number,
  rowsRead: number,
  started: number,
  sizeAfter: number,
): D1Result<T> {
  const meta: LocalD1Meta = {
    duration: performance.now() - started,
    size_after: sizeAfter,
    rows_read: rowsRead,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
  return { success: true, results, meta };
}

/** Apply the existing Worker migrations once, with checksum protection and atomic per-file commits. */
export async function applyVpsMigrations(database: VpsSqliteDatabase, migrationsDirectory: string): Promise<string[]> {
  database.execSyncForMigration(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(filename))
    .sort();
  const files = await Promise.all(
    filenames.map(async (name) => ({ name, sql: await readFile(join(migrationsDirectory, name), "utf8") })),
  );
  const appliedRows = database.readMigrations();
  const appliedByName = new Map(appliedRows.map((row) => [row.name, row.checksum]));
  const available = new Set(files.map((file) => file.name));
  for (const row of appliedRows) {
    if (!available.has(row.name)) throw new Error(`Applied migration ${row.name} is missing from the directory.`);
  }

  const latestApplied = appliedRows.at(-1)?.name ?? null;
  const newlyApplied: string[] = [];
  for (const file of files) {
    const checksum = createHash("sha256").update(file.sql).digest("hex");
    const existing = appliedByName.get(file.name);
    if (existing !== undefined) {
      if (existing !== checksum) throw new Error(`Applied migration ${file.name} changed after it was recorded.`);
      continue;
    }
    if (latestApplied !== null && file.name < latestApplied) {
      throw new Error(`Migration ${file.name} is not append-only; a later migration is already applied.`);
    }
    database.applyMigration(file.name, checksum, file.sql);
    newlyApplied.push(file.name);
  }
  return newlyApplied;
}

/** Open a persistent database after creating its parent directory. */
export async function openVpsSqliteDatabase(path: string): Promise<VpsSqliteDatabase> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return new VpsSqliteDatabase(path);
}

/**
 * Count SQL statements for exec metadata. Semicolons inside quotes/comments and trigger bodies
 * are not statement boundaries.
 */
function countSqlStatements(sql: string) {
  let count = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  let tokens: string[] = [];
  let word = "";
  let trigger = false;
  let triggerDepth = 0;
  let caseDepth = 0;
  let hasContent = false;

  const flushWord = () => {
    if (!word) return;
    const token = word.toUpperCase();
    tokens.push(token);
    if (tokens.length === 1 && token === "CREATE") trigger = false;
    if (tokens.length <= 3 && tokens.includes("CREATE") && token === "TRIGGER") trigger = true;
    if (trigger && token === "BEGIN" && triggerDepth === 0) triggerDepth = 1;
    else if (trigger && token === "CASE" && triggerDepth > 0) caseDepth += 1;
    else if (trigger && token === "END" && caseDepth > 0) caseDepth -= 1;
    else if (trigger && token === "END" && triggerDepth > 0) triggerDepth -= 1;
    word = "";
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if ((quote === "]" && character === "]") || (quote !== "]" && character === quote)) {
        if (quote !== "]" && next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      flushWord();
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      flushWord();
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      flushWord();
      quote = character;
      hasContent = true;
      continue;
    }
    if (character === "[") {
      flushWord();
      quote = "]";
      hasContent = true;
      continue;
    }
    if (/\w/u.test(character)) {
      word += character;
      hasContent = true;
      continue;
    }
    flushWord();
    if (character === ";" && (!trigger || triggerDepth === 0)) {
      if (hasContent) count += 1;
      tokens = [];
      trigger = false;
      caseDepth = 0;
      hasContent = false;
    } else if (!/\s/u.test(character)) {
      hasContent = true;
    }
  }
  flushWord();
  if (hasContent) count += 1;
  return count;
}
