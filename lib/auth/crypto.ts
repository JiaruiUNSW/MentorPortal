const PASSWORD_ITERATIONS = 600_000;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function secretEqual(left: string, right: string): Promise<boolean> {
  // Native HMAC verification supplies a constant-time comparison on both Workers and browsers.
  const key = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(left));
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(right));
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const result = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return toBase64Url(new Uint8Array(result));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(24));
  const digest = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${digest}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256" || parts[1] !== String(PASSWORD_ITERATIONS) || !/^[\w-]{32}$/.test(parts[2]) || !/^[\w-]{43}$/.test(parts[3])) return false;
  const actual = await derivePassword(password, fromBase64Url(parts[2]), PASSWORD_ITERATIONS);
  return secretEqual(actual, parts[3]);
}

export async function consumePasswordWork(password: string): Promise<void> {
  // Failed unknown-account lookups use the same KDF cost as a known account.
  await derivePassword(password, new Uint8Array(24), PASSWORD_ITERATIONS);
}
