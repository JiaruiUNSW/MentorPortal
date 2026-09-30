import { AuthError } from "./errors";

const MAX_BODY_BYTES = 8_192;

export function invalid(message: string): never {
  throw new AuthError(400, "VALIDATION_ERROR", message);
}

export async function readAuthJson(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new AuthError(415, "CONTENT_TYPE_REQUIRED", "Send this request as application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new AuthError(413, "BODY_TOO_LARGE", "The request is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        byteCount += result.value.byteLength;
        if (byteCount > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new AuthError(413, "BODY_TOO_LARGE", "The request is too large.");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return invalid("Send a valid JSON object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Send a valid JSON object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !fields.includes(field))) return invalid("The request contains unsupported fields.");
  return record;
}

export function emailInput(value: unknown): string {
  if (typeof value !== "string") return invalid("Enter your email address.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(email)) return invalid("Enter a valid email address.");
  return email;
}

export function nameInput(value: unknown): string {
  if (typeof value !== "string") return invalid("Enter a display name.");
  const name = value.trim();
  if (!name || [...name].length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return invalid("Use a display name of 1–100 characters.");
  return name;
}

export function passwordInput(value: unknown): string {
  if (typeof value !== "string" || [...value].length < 12 || [...value].length > 128 || !value.trim()) return invalid("Use a password of 12–128 characters.");
  return value;
}

export function identifierInput(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) return invalid(`Enter a valid ${label}.`);
  return value;
}

export function mentorIdInput(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) return invalid("Choose a valid Mentor record ID.");
  return value;
}
