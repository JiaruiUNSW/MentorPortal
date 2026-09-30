"use client";
import { useEffect, useRef } from "react";
import { navigation, type View } from "./shell";
import { useSession } from "./session";

type ModelTool = {
  name: string; title: string; description: string; inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};
type ModelContext = { registerTool: (tool: ModelTool, options?: { signal?: AbortSignal }) => void | Promise<void> };
function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object.");
  return value as Record<string, unknown>;
}
/** Optional browser integration. These tools expose no mutation or account operation. */
export function WebMcpBridge({ active, navigate }: { active: View; navigate: (view: View) => void }) {
  const { session } = useSession();
  const current = useRef({ active, navigate, preview: session?.mode === "demo" });
  useEffect(() => { current.current = { active, navigate, preview: session?.mode === "demo" }; }, [active, navigate, session?.mode]);
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext || (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const visibleState = () => ({
      page: current.current.active,
      title: navigation.find(item => item.id === current.current.active)?.label,
      previewData: current.current.preview,
      dialogOpen: !!document.querySelector('[role="dialog"][data-state="open"]'),
      navigation: navigation.map(({ id, label }) => ({ id, label })),
    });
    const tools: ModelTool[] = [
      {
        name: "mentor_get_visible_state", title: "Read visible portal state",
        description: "Read the current portal page, preview label, dialog-open state and seven available navigation destinations. Does not fetch records or return form values, credentials or personal data.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute(input) { if (Object.keys(objectInput(input)).length) throw new Error("This tool takes no arguments."); return visibleState(); },
      },
      {
        name: "mentor_navigate", title: "Navigate to a portal page",
        description: "Open one of the seven visible mentor navigation destinations. Changes the visible page and may load its records. Does not submit, edit, upload, redeem or change account access. Close any open dialog first.",
        inputSchema: { type: "object", properties: { page: { type: "string", enum: navigation.map(item => item.id) } }, required: ["page"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const value = objectInput(input);
          if (Object.keys(value).some(key => key !== "page") || !navigation.some(item => item.id === value.page)) throw new Error("Choose one of the seven portal navigation destinations.");
          if (document.querySelector('[role="dialog"][data-state="open"]')) throw new Error("Close the current dialog before navigating.");
          current.current.navigate(value.page as View);
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          if (current.current.active !== value.page) throw new Error("Navigation has not completed. Read the visible state before retrying.");
          return visibleState();
        },
      },
    ];
    try {
      void Promise.all(tools.map(tool => Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })))).catch(() => { lifecycle.abort(); });
    } catch { lifecycle.abort(); }
    return () => lifecycle.abort();
  }, []);
  return null;
}
