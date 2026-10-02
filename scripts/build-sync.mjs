import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("standalone-dist", { recursive: true });
await build({
  entryPoints: ["scripts/sync-worker.ts", "scripts/import-auth.ts"],
  outdir: "standalone-dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  external: ["node:*"],
});
