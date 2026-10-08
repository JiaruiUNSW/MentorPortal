"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OperationPayloads } from "@/lib/contracts";
import type { AsyncJob, AsyncOperation } from "@/lib/mentor-data/async-contract";
import { PortalError } from "./api";
import { loadAsyncJobs, retryAsyncJob, submitAsync, type AsyncSubmission } from "./async-client";
import { blocksGroup, canReviewFailure, createAsyncSubmissionLedger, isPendingJob, jobLabel, mergeJobs, reconcileJobList } from "./async-state";
import { useMentorReadOnly, useSession } from "./session";
import { ErrorNotice } from "./ui";

type JobContext = {
  jobs: AsyncJob[]; ready: boolean; error: Error | null;
  refresh: () => Promise<void>;
  retry: (job: AsyncJob) => Promise<void>;
  releaseFailure: (id: string) => boolean;
  submit: <O extends AsyncOperation>(operation: O, payload: OperationPayloads[O]) => Promise<AsyncSubmission<O>>;
};
const AsyncJobsContext = createContext<JobContext | null>(null);

/** Mounted inside the account-keyed Portal, so jobs and retry keys never cross accounts. */
export function AsyncJobsProvider({ children, onSynced }: { children: React.ReactNode; onSynced: () => void }) {
  const { session } = useSession();
  const [jobs, setJobs] = useState<AsyncJob[]>([]);
  const [ready, setReady] = useState(session?.mode === "demo");
  const [error, setError] = useState<Error | null>(null);
  const [ledger] = useState(() => createAsyncSubmissionLedger(submitAsync));
  const jobsRef = useRef<AsyncJob[]>([]);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const acceptedSequence = useRef(0);
  const localAccepts = useRef(new Map<string, number>());
  const synced = useRef(new Set<string>());
  const syncCallback = useRef(onSynced);
  useEffect(() => { syncCallback.current = onSynced; }, [onSynced]);

  const publish = useCallback((next: AsyncJob[]) => {
    if (!mounted.current) return;
    jobsRef.current = next; setJobs(next); ledger.reconcile(next);
    let changed = false;
    for (const job of next) if (job.status === "succeeded" && !synced.current.has(job.id)) { synced.current.add(job.id); changed = true; }
    if (changed) syncCallback.current();
  }, [ledger]);
  const accept = useCallback((job: AsyncJob) => {
    localAccepts.current.set(job.id, ++acceptedSequence.current);
    publish(mergeJobs(jobsRef.current, [job]));
  }, [publish]);
  const refresh = useCallback(async () => {
    if (session?.mode !== "live") return;
    if (inFlight.current) return inFlight.current;
    const sequence = acceptedSequence.current;
    const task = (async () => {
      try {
        const incoming = await loadAsyncJobs();
        if (!mounted.current) return;
        // A complete server list is authoritative for access; retain only newer local acceptances.
        const acceptedDuringLoad = new Set([...localAccepts.current].filter(([, value]) => value > sequence).map(([id]) => id));
        publish(reconcileJobList(jobsRef.current, incoming, acceptedDuringLoad)); setError(null); setReady(true);
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure : new Error("Background update status is unavailable."));
      }
    })();
    inFlight.current = task;
    try { await task; } finally { if (inFlight.current === task) inFlight.current = null; }
  }, [publish, session?.mode]);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const poll = async () => {
      await refresh();
      if (active && session?.mode === "live") timer = setTimeout(poll, 30000);
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    void poll();
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { mounted.current = false; active = false; clearTimeout(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [refresh, session?.mode]);

  // Start frequent polling immediately when this page accepts a new job, even after an idle period.
  const hasPending = jobs.some(isPendingJob);
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [hasPending, refresh]);

  const submit = useCallback(async <O extends AsyncOperation,>(operation: O, payload: OperationPayloads[O]): Promise<AsyncSubmission<O>> => {
    if (!ready) throw new Error("Wait for your existing updates to load before submitting.");
    const blocking = jobsRef.current.find(job => job.groupId === payload.groupId && blocksGroup(job));
    if (blocking) {
      if (blocking.operation === operation && JSON.stringify(blocking.intent.payload) === JSON.stringify(payload)) return { accepted: true, job: blocking };
      throw new Error("This group already has an update awaiting sync or review. Check its status before submitting another update.");
    }
    const result = await ledger.run(operation, payload);
    if (result.accepted) accept(result.job);
    return result;
  }, [accept, ledger, ready]);
  const retry = useCallback(async (job: AsyncJob) => {
    if (!job.canRetry) throw new Error("This update needs review before it can be retried.");
    const next = await retryAsyncJob(job.id); accept(next);
  }, [accept]);
  const releaseFailure = useCallback((id: string) => {
    const job = jobsRef.current.find(item => item.id === id);
    return !!job && ledger.releaseReviewedFailure(job);
  }, [ledger]);

  return <AsyncJobsContext.Provider value={{ jobs, ready, error, refresh, retry, releaseFailure, submit }}>{children}</AsyncJobsContext.Provider>;
}

export function useAsyncJobs() {
  const context = useContext(AsyncJobsContext);
  if (!context) throw new Error("AsyncJobsProvider is required.");
  return context;
}

export function useAsyncMutation() {
  const context = useAsyncJobs();
  const readOnly = useMentorReadOnly();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const running = useRef(false);
  async function run<O extends AsyncOperation>(operation: O, payload: OperationPayloads[O]): Promise<AsyncSubmission<O> | null> {
    if (running.current) return null;
    if (readOnly) { setError(new Error("This portal is currently read-only. Changes are not enabled yet.")); return null; }
    running.current = true; setPending(true); setError(null);
    try { return await context.submit(operation, payload); }
    catch (failure) {
      setError(failure instanceof Error ? failure : new Error("The update was not accepted. Your inputs are preserved."));
      // An interrupted acceptance may already be durable; the job list can recover it without resubmitting.
      if (failure instanceof PortalError && failure.code === "RESPONSE_UNCONFIRMED") void context.refresh();
      return null;
    } finally { running.current = false; setPending(false); }
  }
  return { run, pending, error, readOnly, ready: context.ready };
}

export function AsyncJobsSummary() {
  const { jobs, error, refresh } = useAsyncJobs();
  const pending = jobs.filter(isPendingJob).length;
  const attention = jobs.filter(job => job.status === "failed" || job.status === "needs_review").length;
  return <>
    <ErrorNotice error={error} retry={() => { void refresh(); }} />
    {pending || attention ? <p className="form-hint" role="status">{pending ? `${pending} update${pending === 1 ? " is" : "s are"} syncing in the background. ` : ""}{attention ? `${attention} update${attention === 1 ? " needs" : "s need"} attention in My Groups or Reports.` : "You can continue using the portal."}</p> : null}
  </>;
}

export function JobStatusNotice({ job, onReview }: { job: AsyncJob; onReview?: () => Promise<void> }) {
  const { retry, refresh } = useAsyncJobs();
  const readOnly = useMentorReadOnly();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function retryJob() {
    if (pending) return;
    setPending(true); setError(null);
    try { await retry(job); } catch (failure) { setError(failure as Error); } finally { setPending(false); }
  }
  async function reviewJob() {
    if (pending || !onReview || !canReviewFailure(job)) return;
    setPending(true); setError(null);
    try { await onReview(); } catch (failure) { setError(failure as Error); } finally { setPending(false); }
  }
  const message = isPendingJob(job) ? "Your update is saved in the portal and is waiting to sync with the programme records. You can close this dialog; its status will remain available after refresh."
    : job.status === "succeeded" ? "Your update has synced with the programme records."
    : job.status === "needs_review" ? "The programme result is not confirmed. Your inputs are preserved. Do not submit a duplicate; check this update or contact programme staff."
    : "This update did not sync. Your submitted inputs are preserved below.";
  return <div className="form-stack"><Alert role="status" variant={job.status === "failed" || job.status === "needs_review" ? "destructive" : "default"}><AlertTitle>{jobLabel(job)}</AlertTitle><AlertDescription><p>{message}</p>{job.error ? <p>{job.error.message}</p> : null}{job.canRetry && job.status !== "succeeded" ? <Button type="button" variant="outline" onClick={retryJob} disabled={pending || readOnly}>{pending ? "Checking update…" : job.status === "needs_review" ? "Check saved request" : "Retry saved update"}</Button> : null}{onReview && canReviewFailure(job) ? <Button type="button" variant="outline" onClick={reviewJob} disabled={pending || readOnly}>{pending ? "Loading available record…" : "Review and edit"}</Button> : null}{job.status === "needs_review" && !job.canRetry ? <Button type="button" variant="outline" onClick={() => { void refresh(); }}>Check status</Button> : null}</AlertDescription></Alert><ErrorNotice error={error} /></div>;
}
