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

export function cookieNames(request: Request, configuredOrigin?: string): { session: string; csrf: string; secure: boolean } {
  // The configured public origin survives TLS termination at the trusted proxy.
  // Forwarded host/protocol headers never choose cookie names or security flags.
  // Worker metadata means request.url is the actual edge URL: configuration
  // must not upgrade an insecure public HTTP request on that existing runtime.
  if ("cf" in request && Boolean(request.cf)) applicationOrigin(request);
  const url = new URL(applicationOrigin(request, configuredOrigin));
  const development = url.protocol === "http:" && isLoopback(url);
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

export function setCookie(request: Request, kind: "session" | "csrf", value: string, maxAge: number, configuredOrigin?: string): string {
  const names = cookieNames(request, configuredOrigin);
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

function normalizedIp(address: string | null): string | null {
  if (!address || address.length > 45) return null;
  if (address.includes(":")) {
    // Brackets, ports, zone IDs, whitespace and comma-separated chains are not
    // a single IP. WHATWG's IPv6 literal parser also canonicalizes equivalent
    // spellings so they cannot obtain separate rate-limit buckets.
    if (!/^[a-fA-F0-9:.]+$/.test(address)) return null;
    try { return new URL(`http://[${address}]/`).hostname.slice(1, -1); }
    catch { return null; }
  }
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return null;
  return octets.join(".");
}

export function requestSource(request: Request, options: { trustProxy?: boolean; appOrigin?: string } = {}): string {
  const url = new URL(request.url);
  // Only the Cloudflare runtime's request metadata makes its generated IP header trusted.
  const fromCloudflare = "cf" in request && Boolean(request.cf);
  if (!isLoopback(url) && fromCloudflare) {
    const address = request.headers.get("cf-connecting-ip");
    if (address && /^[a-fA-F0-9:.]{3,64}$/.test(address)) return address;
  }
  if (options.trustProxy === true && options.appOrigin) {
    const publicUrl = new URL(applicationOrigin(request, options.appOrigin));
    if (publicUrl.protocol === "https:" && !isLoopback(publicUrl)) {
      // Deployment must overwrite X-Real-IP and deny direct backend access.
      // An internal loopback URL here is a proxy hop, not local development.
      return normalizedIp(request.headers.get("x-real-ip")) ?? "unidentified-source";
    }
  }
  return isLoopback(url) ? "local-development" : "unidentified-source";
}
