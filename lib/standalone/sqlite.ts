import { createHash } from "node:crypto";
import { closeSync, constants, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { existingPrivateFile, privateDirectory } from "./paths";

export interface SqliteResult<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number; duration: number; changed_db: boolean; rows_read: number; rows_written: number; size_after: number; served_by: string };
}

function boundValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError("SQLite bind values must be finite numbers, strings, booleans, blobs or null.");
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\//g, " ").trim();
}

function checkStatement(statement: StatementSync): void {
  const keyword = withoutComments(statement.sourceSQL).replace(/^(?:;\s*)+/, "").match(/^[a-z]+/i)?.[0]?.toUpperCase();
  if (keyword && ["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH", "DETACH", "VACUUM"].includes(keyword)) {
    throw new Error("Transaction control and attached databases are managed by the storage adapter.");
  }
}

export class SqliteStatement {
  readonly owner: SqliteDatabase;
  readonly sql: string;
  readonly values: SQLInputValue[];

  constructor(owner: SqliteDatabase, sql: string, values: SQLInputValue[] = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): SqliteStatement { return new SqliteStatement(this.owner, this.sql, values.map(boundValue)); }
  async all<T = Record<string, unknown>>(): Promise<SqliteResult<T>> { return this.owner.execute<T>(this); }
  async run<T = Record<string, unknown>>(): Promise<SqliteResult<T>> { return this.owner.execute<T>(this); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = this.owner.execute<Record<string, unknown>>(this);
    const row = result.results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column)) throw new Error("The requested result column does not exist.");
    return row[column] as T;
  }
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = this.owner.execute<Record<string, unknown>>(this);
    const columns = this.owner.columns(this.sql);
    const rows: unknown[][] = result.results.map((row) => columns.map((column) => row[column]));
    if (options?.columnNames) rows.unshift(columns);
    return rows as T[];
  }
}

export class SqliteDatabase {
  private readonly connection: DatabaseSync;
  private closed = false;
  readonly filename: string;

  constructor(filename: string) {
    const directory = privateDirectory(dirname(filename));
    this.filename = join(directory, basename(filename));
    existingPrivateFile(this.filename);
    const descriptor = openSync(this.filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(descriptor);
    for (const file of [`${this.filename}-wal`, `${this.filename}-shm`]) existingPrivateFile(file);
    this.connection = new DatabaseSync(this.filename, { timeout: 5000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    try {
      this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
      for (const file of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) existingPrivateFile(file);
    } catch (error) { this.connection.close(); throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new Error("The portal database is closed."); }

  private compile(sql: string): StatementSync {
    this.assertOpen();
    const statement = this.connection.prepare(sql);
    checkStatement(statement);
    if (withoutComments(sql.slice(statement.sourceSQL.length))) throw new Error("prepare() accepts exactly one SQL statement.");
    return statement;
  }

  prepare(sql: string): SqliteStatement {
    if (typeof sql !== "string" || !sql.trim()) throw new TypeError("A SQL statement is required.");
    return new SqliteStatement(this, sql);
  }
  columns(sql: string): string[] { return this.compile(sql).columns().map((column) => column.name); }

  execute<T = Record<string, unknown>>(prepared: SqliteStatement): SqliteResult<T> {
    if (!(prepared instanceof SqliteStatement) || prepared.owner !== this) throw new TypeError("A batch must contain statements from this database.");
    const statement = this.compile(prepared.sql);
    const started = performance.now();
    const before = this.connection.prepare("SELECT total_changes() AS total").get()!.total as number;
    const hasRows = statement.columns().length > 0;
    const rows = hasRows ? statement.all(...prepared.values).map((row) => ({ ...row })) : [];
    if (!hasRows) statement.run(...prepared.values);
    const metadata = this.connection.prepare("SELECT total_changes() AS total, changes() AS changes, last_insert_rowid() AS lastRow").get()!;
    const written = Number(metadata.total) - before;
    return {
      success: true,
      results: rows as T[],
      meta: { changes: written ? Number(metadata.changes) : 0, last_row_id: Number(metadata.lastRow), duration: performance.now() - started, changed_db: written > 0, rows_read: rows.length, rows_written: written, size_after: 0, served_by: "local-sqlite" },
    };
  }

  private transaction<T>(operation: () => T): T {
    this.assertOpen();
    this.connection.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.connection.exec("COMMIT"); return result; }
    catch (error) { this.connection.exec("ROLLBACK"); throw error; }
  }

  async batch<T = Record<string, unknown>>(statements: SqliteStatement[]): Promise<SqliteResult<T>[]> {
    // Keep the whole transaction synchronous: no request can interleave at an await boundary.
    return this.transaction(() => statements.map((statement) => this.execute<T>(statement)));
  }

  private script(sql: string): number {
    let remaining = sql;
    let count = 0;
    while (withoutComments(remaining)) {
      const statement = this.connection.prepare(remaining);
      checkStatement(statement);
      if (!statement.sourceSQL.length) throw new Error("An empty migration statement was encountered.");
      statement.run();
      remaining = remaining.slice(statement.sourceSQL.length);
      count++;
    }
    return count;
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const count = this.transaction(() => this.script(sql));
    return { count, duration: performance.now() - started };
  }

  migrate(directory: string): void {
    const files = readdirSync(directory).filter((file) => /^\d+_[A-Za-z0-9_-]+\.sql$/.test(file)).sort();
    if (!files.length) throw new Error("No portal database migrations were found.");
    const migrations = files.map((name) => {
      const sql = readFileSync(join(directory, name), "utf8");
      return { name, sql, digest: createHash("sha256").update(sql).digest("hex") };
    });
    this.transaction(() => {
      this.connection.exec("CREATE TABLE IF NOT EXISTS _portal_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      const applied = this.connection.prepare("SELECT name, sha256 FROM _portal_migrations ORDER BY name").all();
      for (const row of applied) {
        const migration = migrations.find((item) => item.name === row.name);
        if (!migration || migration.digest !== row.sha256) throw new Error("An applied portal migration is missing or has changed.");
      }
      for (const migration of migrations) {
        if (applied.some((row) => row.name === migration.name)) continue;
        this.script(migration.sql);
        this.connection.prepare("INSERT INTO _portal_migrations (name,sha256,applied_at) VALUES (?,?,?)").run(migration.name, migration.digest, Date.now());
      }
    });
  }

  close(): void { if (!this.closed) { this.connection.close(); this.closed = true; } }
}
