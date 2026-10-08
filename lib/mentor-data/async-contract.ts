import type { AttachmentDto, BridgeResponse, OperationPayloads, OperationResults } from '../contracts';

/** Browser-safe types only. Async acceptance is opt-in with Prefer: respond-async. */
export type AsyncOperation = 'attendance.save' | 'reports.week1.save' | 'reports.meetup.save' | 'reports.completion.save';
export type AsyncJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_review';
export type AsyncJobError = Extract<BridgeResponse, { ok: false }>['error'];
interface AsyncJobBase {
  id: string;
  groupId: string;
  status: AsyncJobStatus;
  requestId: string;
  createdAt: string;
  updatedAt: string;
  /** A UI-only identity for a new report; never a valid upstream record ID. */
  clientRecordId?: string;
  /** Owned metadata only. Bytes still use the authenticated attachment API. */
  attachments: AttachmentDto[];
  error?: AsyncJobError;
  canRetry: boolean;
}
export type AsyncJob = {
  [O in AsyncOperation]: AsyncJobBase & {
    operation: O;
    intent: { operation: O; payload: OperationPayloads[O] };
    result?: OperationResults[O];
  }
}[AsyncOperation];
export type AsyncAcceptedResponse = {
  schemaVersion: '1.0'; requestId: string; ok: true; accepted: true;
  data: { job: AsyncJob }; replayed?: boolean;
};
export type AsyncJobResponse = {
  schemaVersion: '1.0'; requestId: string; ok: true; data: { job: AsyncJob };
};
export type AsyncJobsResponse = {
  schemaVersion: '1.0'; requestId: string; ok: true;
  data: { items: AsyncJob[]; nextCursor: string | null };
};
