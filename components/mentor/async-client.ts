import type { OperationPayloads, OperationResults } from "@/lib/contracts";
import type { AsyncAcceptedResponse, AsyncJob, AsyncJobResponse, AsyncJobsResponse, AsyncOperation } from "@/lib/mentor-data/async-contract";
import { PortalError, requestJson } from "./api";

export type AsyncSubmission<O extends AsyncOperation = AsyncOperation> =
  | { accepted: true; job: AsyncJob }
  | { accepted: false; data: OperationResults[O] };

/** Only attendance/report clients opt in. All other writes retain their existing response contract. */
export async function submitAsync<O extends AsyncOperation>(operation: O, payload: OperationPayloads[O], idempotencyKey: string): Promise<AsyncSubmission<O>> {
  const result = await requestJson<AsyncAcceptedResponse | { ok: true; data: OperationResults[O]; accepted?: false }>(
    "/api/mentor", { operation, payload, idempotencyKey }, true, { preferAsync: true },
  );
  if (result.accepted) {
    if (result.data.job.operation !== operation || result.data.job.groupId !== payload.groupId) throw new PortalError("The saved update could not be matched to this group. Check its sync status before submitting again.", "RESPONSE_UNCONFIRMED");
    return { accepted: true, job: result.data.job };
  }
  return { accepted: false, data: result.data };
}

export async function loadAsyncJobs(): Promise<AsyncJob[]> {
  const items = new Map<string, AsyncJob>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response: AsyncJobsResponse = await requestJson(`/api/mentor/jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    for (const job of response.data.items) items.set(job.id, job);
    cursor = response.data.nextCursor;
    if (cursor && cursors.has(cursor)) throw new PortalError("Your background updates could not be fully loaded. Please check again.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...items.values()];
}

export async function retryAsyncJob(id: string): Promise<AsyncJob> {
  const response = await requestJson<AsyncJobResponse>(`/api/mentor/jobs/${encodeURIComponent(id)}/retry`, {});
  return response.data.job;
}
