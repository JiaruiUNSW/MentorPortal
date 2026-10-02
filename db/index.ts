import { getRawDb } from "../lib/runtime";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  return drizzle(getRawDb(), { schema });
}
