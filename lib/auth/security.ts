import { hashToken, secretEqual } from "./crypto";
import { AuthError } from "./errors";

export function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function applicationOrigin(request: Request, configuredOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(configuredOrigin || request.url);
  } catch {
    throw new AuthError(503, "AUTH_UNAVAILABLE", "Account access is not configured. Please contact the portal administrator.");
  }
  if (configuredOrigin && (url.pathname !== "/" || url.search || url.hash || url.username || url.password)) {
    throw new AuthError(503, "AUTH_UNAVAILABLE", "Account access is not configured. Please contact the portal administrator.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new AuthError(503, "AUTH_UNAVAILABLE", "Secure account access requires HTTPS.");
  }
  return url.origin;
}

export function checkOrigin(request: Request, configuredOrigin?: string): void {
  const expected = applicationOrigin(request, configuredOrigin);
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || origin !== expected || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
    throw new AuthError(403, "ORIGIN_INVALID", "This request must come from this portal. Reload the page and try again.");
  }
}

export function cookieNames(request: Request): { session: string; csrf: string; secure: boolean } {
  const url = new URL(request.url);
  const development = url.protocol === "http:" && isLoopback(url);
  if (url.protocol !== "https:" && !development) throw new AuthError(503, "AUTH_UNAVAILABLE", "Secure account access requires HTTPS.");
  return development
    ? { session: "mentor_session_dev", csrf: "mentor_csrf_dev", secure: false }
    : { session: "__Host-mentor_session", csrf: "__Host-mentor_csrf", secure: true };
}

export function getCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : null;
}

export function setCookie(request: Request, kind: "session" | "csrf", value: string, maxAge: number): string {
  const names = cookieNames(request);
  return `${names[kind]}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${names.secure ? "; Secure" : ""}`;
}

export function csrfForToken(token: string): Promise<string> {
  return hashToken(`mentor-portal-csrf-v1:${token}`);
}

export async function checkCsrf(request: Request, token: string | null): Promise<void> {
  const supplied = request.headers.get("x-csrf-token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/.test(supplied) || !await secretEqual(supplied, await csrfForToken(token))) {
    throw new AuthError(403, "CSRF_INVALID", "Your security token has expired. Reload the page and try again.");
  }
}

export function requestSource(request: Request): string {
  const url = new URL(request.url);
  // Only the Cloudflare runtime's request metadata makes its generated IP header trusted.
  const fromCloudflare = "cf" in request && Boolean(request.cf);
  if (!isLoopback(url) && fromCloudflare) {
    const address = request.headers.get("cf-connecting-ip");
    if (address && /^[a-fA-F0-9:.]{3,64}$/.test(address)) return address;
  }
  return isLoopback(url) ? "local-development" : "unidentified-source";
}
