"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Operation, OperationPayloads, OperationResults } from "@/lib/contracts";
import { mentorRequest } from "./api";
export function useResource<T>(load: () => Promise<T>, revision: unknown = 0) {
  const [state, setState] = useState<{ data: T | null; error: Error | null; pending: boolean; loader: () => Promise<T>; revision: unknown }>({ data: null, error: null, pending: true, loader: load, revision });
  const request = useRef(0);
  const perform = useCallback(async () => {
    const id = ++request.current;
    try { const data = await load(); if (id === request.current) setState({ data, error: null, pending: false, loader: load, revision }); }
    catch (error) { if (id === request.current) setState(previous => ({ ...previous, data: previous.loader === load && previous.revision === revision ? previous.data : null, error: error instanceof Error ? error : new Error("Unable to load this information."), pending: false, loader: load, revision })); }
  }, [load, revision]);
  const reload = useCallback(async () => { setState(previous => ({ ...previous, pending: true, error: null })); await perform(); }, [perform]);
  useEffect(() => { void perform(); return () => { request.current += 1; }; }, [perform]);
  const setData = useCallback((value: React.SetStateAction<T | null>) => setState(previous => ({ ...previous, data: typeof value === "function" ? (value as (current: T | null) => T | null)(previous.data) : value })), []);
  return { data: state.data, setData, loading: state.pending || state.loader !== load || state.revision !== revision, error: state.loader === load && state.revision === revision ? state.error : null, reload };
}
const uncertainKeys = new Map<string, string>();
export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function run<O extends Operation>(operation: O, payload: OperationPayloads[O]): Promise<OperationResults[O] | null> {
    setPending(true); setError(null);
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([operation, payload])));
      const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const key = uncertainKeys.get(signature) || crypto.randomUUID();
      uncertainKeys.set(signature, key);
      const result = await mentorRequest(operation, payload, key); uncertainKeys.delete(signature); return result; }
    catch (e) { setError(e instanceof Error ? e : new Error("The change was not saved. Please try again.")); return null; }
    finally { setPending(false); }
  }
  return { run, pending, error, clearError: () => setError(null) };
}

export function usePagedResource<T extends { id: string }>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>, revision: unknown = 0) {
  const first = useCallback(() => load(), [load]);
  const resource = useResource(first, revision);
  const source = useRef<{ load: typeof load; revision: unknown } | null>({ load, revision });
  const [pageState, setPageState] = useState<{ load: typeof load; revision: unknown; loading: boolean; error: Error | null }>({ load, revision, loading: false, error: null });
  useEffect(() => { source.current = { load, revision }; return () => { source.current = null; }; }, [load, revision]);
  const ownsState = pageState.load === load && pageState.revision === revision;
  const loadingMore = ownsState && pageState.loading;
  async function more() {
    if (!resource.data?.nextCursor || loadingMore || resource.loading) return;
    setPageState({ load, revision, loading: true, error: null });
    try {
      const next = await load(resource.data.nextCursor);
      if (source.current?.load === load && source.current.revision === revision) {
        resource.setData(previous => ({ items: [...new Map([...(previous?.items || []), ...next.items].map(item => [item.id, item])).values()], nextCursor: next.nextCursor }));
        setPageState({ load, revision, loading: false, error: null });
      }
    } catch (error) {
      if (source.current?.load === load && source.current.revision === revision) setPageState({ load, revision, loading: false, error: error as Error });
    }
  }
  return { ...resource, pageError: ownsState ? pageState.error : null, loadingMore, more };
}
