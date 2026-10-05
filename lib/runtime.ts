export interface PortalBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  PORTAL_MODE?: "demo" | "live";
  APP_ORIGIN?: string;
  SETUP_TOKEN?: string;
  MENTOR_BRIDGE_KEY?: string;
  MENTOR_LIVE_WRITES_ENABLED?: string;
  MENTOR_REDEEM_ENABLED?: string;
  MENTOR_READ_URL?: string;
  MENTOR_ATTENDANCE_URL?: string;
  MENTOR_REPORT_URL?: string;
  MENTOR_EXPENSE_URL?: string;
  MENTOR_ATTACHMENT_URL?: string;
  MENTOR_PROFILE_URL?: string;
  MENTOR_REDEEM_URL?: string;
  MENTOR_TICKET_URL?: string;
  MENTOR_CACHE_ENABLED?: string;
  MENTOR_CACHE_PRIVATE_TTL_HOURS?: string;
  MENTOR_CACHE_CATALOG_TTL_HOURS?: string;
  MENTOR_CACHE_MAX_STALE_HOURS?: string;
  MENTOR_SYNC_ALLOWED_USER_IDS?: string;
  MENTOR_USSO_ENABLED?: string;
  MENTOR_USSO_ISSUER?: string;
  MENTOR_USSO_CLIENT_ID?: string;
  MENTOR_USSO_CLIENT_SECRET?: string;
  TRUST_PROXY?: string;
}

const providerKey = Symbol.for("mentor.portal.bindings-provider");
type RuntimeGlobal = typeof globalThis & { [providerKey]?: () => PortalBindings };

/** Installed by the server entrypoint; browser input never selects a runtime. */
export function setBindingsProvider(provider: () => PortalBindings): void {
  (globalThis as RuntimeGlobal)[providerKey] = provider;
}

export function getBindings(): PortalBindings {
  const provider = (globalThis as RuntimeGlobal)[providerKey];
  if (!provider) throw new Error("Portal runtime has not been initialized.");
  return provider();
}

export function getRawDb(): D1Database {
  const db = getBindings().DB;
  if (!db) throw new Error("Portal storage is unavailable. Please try again later.");
  return db;
}

export function getPortalMode(): "demo" | "live" {
  return getBindings().PORTAL_MODE === "demo" ? "demo" : "live";
}

export interface Principal {
  accountId: string;
  email: string;
  displayName: string;
  mentorUserId: number;
  role: "mentor" | "admin";
  mode: "demo" | "live";
}
