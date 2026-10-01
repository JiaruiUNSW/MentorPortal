import { env } from "cloudflare:workers";

export interface PortalBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  PORTAL_MODE?: "demo" | "live";
  APP_ORIGIN?: string;
  SETUP_TOKEN?: string;
  MENTOR_BRIDGE_KEY?: string;
  MENTOR_LIVE_WRITES_ENABLED?: string;
  MENTOR_READ_URL?: string;
  MENTOR_ATTENDANCE_URL?: string;
  MENTOR_REPORT_URL?: string;
  MENTOR_EXPENSE_URL?: string;
  MENTOR_ATTACHMENT_URL?: string;
  MENTOR_PROFILE_URL?: string;
  MENTOR_REDEEM_URL?: string;
  MENTOR_TICKET_URL?: string;
}

export function getBindings(): PortalBindings {
  return env as unknown as PortalBindings;
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
