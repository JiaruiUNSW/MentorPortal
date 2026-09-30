import type { Operation, OperationPayloads, OperationResults } from "@/lib/contracts";
import type { Principal } from "@/lib/runtime";
export type Session = { user: Principal | null; mode: "demo" | "live"; csrfToken: string };
let csrfToken = "";
export class PortalError extends Error {
  constructor(message: string, public code = "REQUEST_FAILED", public requestId?: string) { super(message); this.name = "PortalError"; }
}
export async function requestJson<T>(path: string, body?: unknown, retry = true): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new PortalError(path === "/api/mentor" ? "We couldn’t confirm the response. Your inputs are preserved; retrying unchanged will safely check the same request." : "We couldn’t confirm the response. Check your connection and the current account status before trying again.", "RESPONSE_UNCONFIRMED"); }
  const result = await response.json().catch(() => null) as { csrfToken?: string; error?: { code?: string; message?: string }; requestId?: string } | null;
  if (result?.csrfToken) csrfToken = result.csrfToken;
  if (response.status === 403 && result?.error?.code === "CSRF_INVALID" && retry) { await readSession(); return requestJson<T>(path, body, false); }
  if (!response.ok && !(path === "/api/auth/session" && response.status === 401)) {
    throw new PortalError(result?.error?.message || "This request couldn’t be completed. Please try again.", result?.error?.code, result?.requestId);
  }
  if (!result) throw new PortalError("The portal returned an unexpected response. Please try again.");
  return result as T;
}
export function readSession() { return requestJson<Session>("/api/auth/session"); }
export function authenticate(kind: "login" | "demo" | "activate" | "setup" | "logout", payload: unknown) { return requestJson<Session>(`/api/auth/${kind}`, payload); }
export async function mentorRequest<O extends Operation>(operation: O, payload: OperationPayloads[O], idempotencyKey?: string): Promise<OperationResults[O]> {
  const result = await requestJson<{ ok: boolean; data: OperationResults[O]; error?: { code: string; message: string }; requestId: string }>("/api/mentor", { operation, payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
  if (!result.ok) throw new PortalError(result.error?.message || "The request was not saved.", result.error?.code, result.requestId);
  return result.data;
}
