import { getBindings, getPortalMode, getRawDb, type Principal } from "./runtime";
import { AuthError } from "./auth/errors";
import { AuthService } from "./auth/service";

export { AuthError };

function service(): AuthService {
  const bindings = getBindings();
  return new AuthService(getRawDb(), { mode: getPortalMode(), appOrigin: bindings.APP_ORIGIN, trustProxy: bindings.TRUST_PROXY === 'true', setupToken: bindings.SETUP_TOKEN, liveWritesEnabled: bindings.MENTOR_LIVE_WRITES_ENABLED === 'true', usso: { enabled: bindings.MENTOR_USSO_ENABLED === "true", issuer: bindings.MENTOR_USSO_ISSUER, clientId: bindings.MENTOR_USSO_CLIENT_ID, clientSecret: bindings.MENTOR_USSO_CLIENT_SECRET } });
}

export function requireSession(request: Request): Promise<Principal> {
  return service().requireSession(request);
}

export function requireAdmin(request: Request): Promise<Principal> {
  return service().requireAdmin(request);
}

export function requireMutationProtection(request: Request): Promise<void> {
  return service().requireMutationProtection(request);
}

export function authErrorResponse(error: unknown): Response {
  const known = error instanceof AuthError ? error : new AuthError(503, "AUTH_UNAVAILABLE", "Account access is temporarily unavailable. Please try again later.");
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  if (known.retryAfter) headers.set("Retry-After", String(known.retryAfter));
  return new Response(JSON.stringify({ error: { code: known.code, message: known.message }, mode: getPortalMode() }), { status: known.status, headers });
}

type AuthAction = "session" | "login" | "demo" | "activate" | "logout" | "setup" | "accounts" | "invites" | "createInvite" | "revokeInvite" | "revokeAccount" | "ussoStart" | "ussoCallback";

export async function handleAuth(request: Request, action: AuthAction): Promise<Response> {
  try { return await service()[action](request); }
  catch (error) {
    if (!(error instanceof AuthError)) {
      // Never log the request, raw exception, password, token or database values.
      const code = error instanceof Error && /\bD1_ERROR\b/.test(error.message) ? "AUTH_DATABASE_ERROR"
        : error instanceof Error && error.name === "NotSupportedError" ? "AUTH_RUNTIME_UNSUPPORTED"
        : "AUTH_UNEXPECTED_ERROR";
      console.error("mentor_auth_failure", { action, code });
    }
    return authErrorResponse(error);
  }
}
