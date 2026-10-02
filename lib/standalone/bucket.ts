import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./paths";

const MAGIC = Buffer.from("MPBUCKET1\n");
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
type PutValue = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array> | null;
type Metadata = { key: string; size: number; etag: string; uploaded: string; httpMetadata: Record<string, string>; customMetadata: Record<string, string> };

function validKey(key: string): void {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/.test(key) || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("The attachment storage key is invalid.");
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Object metadata must contain string values.");
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => key.length > 256 || typeof item !== "string" || item.length > 4096)) throw new TypeError("Object metadata must contain bounded string values.");
  return Object.fromEntries(entries) as Record<string, string>;
}

async function bytesFrom(value: PutValue): Promise<Buffer> {
  let bytes: Buffer;
  if (value === null) bytes = Buffer.alloc(0);
  else if (typeof value === "string") bytes = Buffer.from(value);
  else if (value instanceof ArrayBuffer) bytes = Buffer.from(new Uint8Array(value));
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  else if (value instanceof Blob) {
    if (value.size > MAX_BYTES) throw new RangeError("The attachment exceeds the storage limit.");
    bytes = Buffer.from(await value.arrayBuffer());
  } else if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw new TypeError("Attachment streams must contain bytes.");
        size += result.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new RangeError("The attachment exceeds the storage limit."); }
        chunks.push(Buffer.from(result.value));
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(chunks, size);
  } else throw new TypeError("Unsupported attachment body.");
  if (bytes.length > MAX_BYTES) throw new RangeError("The attachment exceeds the storage limit.");
  return bytes;
}

export class LocalBucketObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;
  readonly body: ReadableStream<Uint8Array>;
  private readonly bytes: Uint8Array<ArrayBuffer>;

  constructor(metadata: Metadata, bytes: Buffer) {
    this.key = metadata.key;
    this.size = metadata.size;
    this.etag = metadata.etag;
    this.httpEtag = `"${metadata.etag}"`;
    this.uploaded = new Date(metadata.uploaded);
    this.httpMetadata = { ...metadata.httpMetadata };
    this.customMetadata = { ...metadata.customMetadata };
    this.bytes = new Uint8Array(bytes);
    this.body = new ReadableStream({ start: (controller) => { controller.enqueue(this.bytes.slice()); controller.close(); } });
  }

  async arrayBuffer(): Promise<ArrayBuffer> { return this.bytes.slice().buffer; }
  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
  async json<T>(): Promise<T> { return JSON.parse(await this.text()) as T; }
  async blob(): Promise<Blob> { return new Blob([this.bytes], { type: this.httpMetadata.contentType }); }
}

export class FileBucket {
  readonly directory: string;
  constructor(directory: string) { this.directory = privateDirectory(directory); }

  private path(key: string): string {
    validKey(key);
    // Keys are never interpreted as filesystem paths, even after validation.
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.object`);
  }

  async put(key: string, value: PutValue, options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {}): Promise<LocalBucketObject> {
    const destination = this.path(key);
    if (Object.keys(options).some((field) => !["httpMetadata", "customMetadata"].includes(field))) throw new TypeError("This storage adapter does not support conditional or multipart uploads.");
    const bytes = await bytesFrom(value);
    const metadata: Metadata = { key, size: bytes.length, etag: createHash("sha256").update(bytes).digest("hex"), uploaded: new Date().toISOString(), httpMetadata: stringRecord(options.httpMetadata), customMetadata: stringRecord(options.customMetadata) };
    const encoded = Buffer.from(JSON.stringify(metadata));
    if (encoded.length > MAX_METADATA_BYTES) throw new RangeError("Attachment metadata is too large.");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.length);
    const temporary = join(this.directory, `.upload-${randomUUID()}`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(Buffer.concat([MAGIC, length, encoded, bytes]));
      await file.sync();
      await file.close();
      await rename(temporary, destination);
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return new LocalBucketObject(metadata, bytes);
  }

  async get(key: string, options?: unknown): Promise<LocalBucketObject | null> {
    const path = this.path(key);
    if (options !== undefined) throw new TypeError("This storage adapter does not support range or conditional reads.");
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES + MAX_METADATA_BYTES + MAGIC.length + 4) throw new Error("The attachment storage object is invalid.");
      const encoded = await file.readFile();
      if (encoded.length < MAGIC.length + 4 || !encoded.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("The attachment storage object is invalid.");
      const headerSize = encoded.readUInt32BE(MAGIC.length);
      if (headerSize > MAX_METADATA_BYTES || encoded.length < MAGIC.length + 4 + headerSize) throw new Error("The attachment storage object is invalid.");
      const offset = MAGIC.length + 4 + headerSize;
      const metadata = JSON.parse(encoded.subarray(MAGIC.length + 4, offset).toString("utf8")) as Metadata;
      const bytes = encoded.subarray(offset);
      if (metadata.key !== key || metadata.size !== bytes.length || metadata.etag !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The attachment storage object could not be verified.");
      return new LocalBucketObject(metadata, bytes);
    } finally { await file.close(); }
  }

  async delete(key: string | string[]): Promise<void> {
    const paths = (Array.isArray(key) ? key : [key]).map((item) => this.path(item));
    for (const path of paths) {
      try { await unlink(path); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
}
