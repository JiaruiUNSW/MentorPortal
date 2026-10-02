import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PortalBindings } from "../runtime";
import { FileBucket } from "./bucket";
import { privateDirectory } from "./paths";
import { SqliteDatabase } from "./sqlite";

export { FileBucket } from "./bucket";
export { SqliteDatabase } from "./sqlite";

export interface StandaloneOptions {
  env?: Record<string, string | undefined>;
  dataDir?: string;
  migrationsDir?: string;
}
export interface StandaloneBindings extends PortalBindings { close(): void }

export function createStandaloneBindings(options: StandaloneOptions = {}): StandaloneBindings {
  const env = options.env ?? process.env;
  const directory = privateDirectory(options.dataDir ?? env.DATA_DIR ?? join(homedir(), ".local", "share", "mentor-portal"));
  const database = new SqliteDatabase(join(directory, "portal.sqlite"));
  try {
    database.migrate(resolve(options.migrationsDir ?? env.MIGRATIONS_DIR ?? join(process.cwd(), "drizzle")));
    const bucket = new FileBucket(join(directory, "objects"));
    const settings = Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === "string" && (key.startsWith("MENTOR_") || ["APP_ORIGIN", "SETUP_TOKEN", "TRUST_PROXY"].includes(key))));
    return {
      ...settings,
      PORTAL_MODE: env.PORTAL_MODE === "demo" ? "demo" : "live",
      MENTOR_LIVE_WRITES_ENABLED: env.MENTOR_LIVE_WRITES_ENABLED === "true" ? "true" : "false",
      MENTOR_CACHE_ENABLED: env.MENTOR_CACHE_ENABLED === "false" ? "false" : "true",
      // This is the compatibility boundary. Only the app's documented D1/R2 subset is implemented.
      DB: database as unknown as D1Database,
      BUCKET: bucket as unknown as R2Bucket,
      close: () => database.close(),
    };
  } catch (error) { database.close(); throw error; }
}

let cached: StandaloneBindings | undefined;
export function getStandaloneBindings(): StandaloneBindings {
  cached ??= createStandaloneBindings();
  return cached;
}
