import { getStandaloneBindings } from "../lib/standalone";
import { runDueSync } from "../lib/mentor-cache";
import { setBindingsProvider } from "../lib/runtime";

const once = process.argv.includes("--once");
const force = process.argv.includes("--force");
if (force && !once) throw new Error("--force requires --once; scheduled runs always respect the refresh intervals.");
const bindings = getStandaloneBindings();
setBindingsProvider(() => bindings);
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let wake: (() => void) | undefined;
const stop = () => { stopping = true; if (timer) clearTimeout(timer); wake?.(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

try {
  do {
    try {
      const result = await runDueSync(bindings, { force });
      console.log(JSON.stringify({ event: "mentor_sync_tick", at: new Date().toISOString(), outcome: result.status,
        accountsChecked: result.accountsChecked, namespaceChecks: result.results.length, synced: result.results.filter(item => item.status === "synced").length,
        errorCodes: [...new Set(result.results.map(item => item.errorCode).filter(Boolean))] }));
      if (once && result.status === "partial") process.exitCode = 1;
    } catch {
      // Upstream exceptions may contain signed URLs or source records.
      console.error(JSON.stringify({ event: "mentor_sync_tick", at: new Date().toISOString(), outcome: "failed" }));
      if (once) process.exitCode = 1;
    }
    if (!once && !stopping) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 30_000); });
  } while (!once && !stopping);
} finally { bindings.close(); }
