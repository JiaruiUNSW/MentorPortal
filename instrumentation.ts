export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getStandaloneBindings } = await import("./lib/standalone");
    const { setBindingsProvider } = await import("./lib/runtime");
    setBindingsProvider(() => getStandaloneBindings());
  }
}
