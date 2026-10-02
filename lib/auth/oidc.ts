import * as oidc from "openid-client";
import { AuthError } from "./errors";

export const USSO_CALLBACK_PATH = "/api/auth/usso/callback";
export const USSO_TRANSACTION_SECONDS = 600;

export interface UssoSettings {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}
export interface UssoConfiguration {
  issuer: string;
  clientId: string;
  clientSecret: string;
}
export interface OidcTransaction {
  state_hash: string;
  browser_hash: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  intent: "login" | "link";
  nonce: string;
  code_verifier: string;
  account_id: string | null;
  session_hash: string | null;
  expires_at: number;
}

export function ussoConfiguration(settings?: UssoSettings): UssoConfiguration | null {
  if (!settings?.enabled) return null;
  const { issuer, clientId, clientSecret } = settings;
  if (!issuer || !clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 4096) return null;
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.href !== issuer) return null;
  } catch { return null; }
  return { issuer, clientId, clientSecret };
}

function checkEndpoint(value: string | undefined, issuer: string): void {
  if (!value) throw new Error("OIDC endpoint is missing.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== new URL(issuer).origin || url.username || url.password || url.hash) throw new Error("OIDC endpoint is outside the configured provider.");
}

async function configuration(settings: UssoConfiguration, fetcher: typeof fetch): Promise<oidc.Configuration> {
  const permittedOrigin = new URL(settings.issuer).origin;
  const guardedFetch: oidc.CustomFetch = async (input, init) => {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.origin !== permittedOrigin || url.username || url.password || url.hash) throw new Error("OIDC request target is invalid.");
    const requestBody = init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body;
    const response = await fetcher(input, { ...init, body: requestBody, redirect: "error" });
    // Metadata, token and key documents are all small; enforce the actual body size.
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 256 * 1024) { await reader.cancel(); throw new Error("OIDC response exceeds its limit."); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const config = await oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    { client_secret: settings.clientSecret, id_token_signed_response_alg: "RS256" },
    oidc.ClientSecretBasic(settings.clientSecret),
    { timeout: 10, [oidc.customFetch]: guardedFetch, execute: [oidc.enableNonRepudiationChecks] },
  );
  const metadata = config.serverMetadata();
  if (metadata.issuer !== settings.issuer || !metadata.code_challenge_methods_supported?.includes("S256") || !metadata.id_token_signing_alg_values_supported?.includes("RS256")) throw new Error("OIDC provider metadata is incompatible.");
  checkEndpoint(metadata.authorization_endpoint, settings.issuer);
  checkEndpoint(metadata.token_endpoint, settings.issuer);
  checkEndpoint(metadata.jwks_uri, settings.issuer);
  return config;
}

export async function ussoAuthorizationUrl(settings: UssoConfiguration, transaction: Pick<OidcTransaction, "redirect_uri" | "nonce" | "code_verifier" | "intent">, state: string, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const config = await configuration(settings, fetcher);
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: transaction.redirect_uri,
      scope: "openid profile email",
      response_type: "code",
      response_mode: "query",
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.code_verifier),
      code_challenge_method: "S256",
      state,
      nonce: transaction.nonce,
      ...(transaction.intent === "link" ? { prompt: "login" } : {}),
    }).href;
  } catch {
    throw new AuthError(503, "USSO_UNAVAILABLE", "USSO is temporarily unavailable. You can still sign in with your portal password.");
  }
}

export async function verifyUssoCallback(settings: UssoConfiguration, transaction: OidcTransaction, callbackUrl: URL, state: string, fetcher: typeof fetch = fetch): Promise<{ issuer: string; subject: string }> {
  try {
    const config = await configuration(settings, fetcher);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.code_verifier,
      expectedState: state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims || claims.iss !== settings.issuer || typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) throw new Error("OIDC subject is invalid.");
    // Access/refresh/ID tokens and profile claims are neither persisted nor returned to the browser.
    return { issuer: settings.issuer, subject: claims.sub };
  } catch {
    throw new AuthError(401, "USSO_FAILED", "USSO sign-in could not be verified. Please start again or use your portal password.");
  }
}
