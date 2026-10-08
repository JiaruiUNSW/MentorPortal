import type { GroupDto, MenteeDto, OperationPayloads, OperationResults, ReportDto, ReportKind } from "@/lib/contracts";
import type { AsyncJob, AsyncOperation } from "@/lib/mentor-data/async-contract";
import type { AsyncSubmission } from "./async-client";

export type ReportJob = Exclude<AsyncJob, { operation: "attendance.save" }>;
export type AttendanceJob = Extract<AsyncJob, { operation: "attendance.save" }>;
export const isReportJob = (job: AsyncJob): job is ReportJob => job.operation !== "attendance.save";
export const isPendingJob = (job: AsyncJob) => job.status === "queued" || job.status === "running";
export const blocksGroup = (job: AsyncJob) => isPendingJob(job) || job.status === "needs_review";
export const canReviewFailure = (job: AsyncJob) => job.status === "failed" && !job.canRetry;
export const jobLabel = (job: AsyncJob) => job.status === "succeeded" ? "Synced" : job.status === "failed" ? "Sync failed" : job.status === "needs_review" ? "Needs review" : "Pending sync";
export function jobReportKind(job: ReportJob): ReportKind {
  return job.operation === "reports.week1.save" ? "week1" : job.operation === "reports.meetup.save" ? "meetup" : "completion";
}
export function jobReportTitle(job: ReportJob) {
  return job.operation === "reports.meetup.save" ? job.intent.payload.title : job.operation === "reports.week1.save" ? "Week 1" : "Completion";
}
export function confirmedJobReport(job?: ReportJob): ReportDto | undefined {
  return job?.status === "succeeded" ? job.result?.report : undefined;
}

/** Ignore late queued/running snapshots after a terminal result, while allowing an explicit retry. */
export function mergeJobs(current: AsyncJob[], incoming: AsyncJob[]): AsyncJob[] {
  const jobs = new Map(current.map(job => [job.id, job]));
  for (const job of incoming) {
    const existing = jobs.get(job.id);
    if (!existing || job.updatedAt > existing.updatedAt || (job.updatedAt === existing.updatedAt && (!blocksGroup(job) || blocksGroup(existing)))) jobs.set(job.id, job);
  }
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function reconcileJobList(current: AsyncJob[], incoming: AsyncJob[], acceptedDuringLoad: Set<string>): AsyncJob[] {
  const visibleIds = new Set(incoming.map(job => job.id));
  return mergeJobs(current.filter(job => visibleIds.has(job.id) || acceptedDuringLoad.has(job.id)), incoming);
}

export type ReportRow = { key: string; kind: ReportKind; title: string; date: string | null; report?: ReportDto; job?: ReportJob };
export function reportRows(source: ReportDto[], jobs: AsyncJob[], groupId: string, kind?: ReportKind): ReportRow[] {
  const rows = new Map<string, ReportRow>(source.filter(report => report.groupId === groupId).map(report => [report.id, { key: report.id, kind: report.kind, title: report.title, date: report.meetupDate || report.createdAt || report.modifiedAt, report }]));
  const relevant = jobs.filter((job): job is ReportJob => job.groupId === groupId && isReportJob(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const job of relevant) {
    const confirmed = confirmedJobReport(job);
    const id = confirmed?.id || job.intent.payload.reportId || job.clientRecordId || `job_${job.id}`;
    const existing = rows.get(id)?.report;
    if (confirmed) {
      // A later source version takes precedence over an older job receipt.
      const report = existing && existing.version !== job.intent.payload.expectedVersion ? existing : confirmed;
      rows.set(id, { key: id, kind: report.kind, title: report.title, date: report.meetupDate || report.createdAt || report.modifiedAt, report });
    } else {
      rows.set(id, { key: id, kind: jobReportKind(job), title: jobReportTitle(job), date: job.operation === "reports.meetup.save" ? job.intent.payload.meetupDate : job.createdAt, report: existing, job });
    }
  }
  return [...rows.values()].filter(row => !kind || row.kind === kind).sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.key.localeCompare(b.key));
}

export function attendanceOverlay(group: GroupDto, mentees: MenteeDto[], jobs: AsyncJob[]) {
  const job = jobs.filter((item): item is AttendanceJob => item.groupId === group.id && item.operation === "attendance.save").sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))[0];
  if (job?.status === "succeeded" && job.result && group.version === job.intent.payload.expectedVersion) return { group: job.result.group, mentees: job.result.mentees, job, pendingIds: new Set<string>() };
  if (!job || !isPendingJob(job)) return { group, mentees, job, pendingIds: new Set<string>() };
  const entries = new Map(job.intent.payload.entries.map(entry => [entry.menteeId, entry.attended]));
  return { group, job, pendingIds: new Set(entries.keys()), mentees: mentees.map(mentee => entries.has(mentee.id) ? { ...mentee, attended: entries.get(mentee.id)!, attendanceRecorded: true } : mentee) };
}

/** UI-only IDs can never become expense mutation targets. */
export function expenseReportId(report?: ReportDto): string | null {
  return report && report.kind === "meetup" && report.submissionState === "submitted" && report.isUseGC && !report.id.startsWith("pending_") && !report.id.startsWith("job_") ? report.id : null;
}

type AsyncSender = <O extends AsyncOperation>(operation: O, payload: OperationPayloads[O], key: string) => Promise<AsyncSubmission<O>>;
/** One ledger per signed-in Portal instance: identical uncertain attempts keep their key. */
export function createAsyncSubmissionLedger(send: AsyncSender, makeKey: () => string = () => crypto.randomUUID()) {
  type Attempt = { key: string; running?: Promise<AsyncSubmission>; accepted?: AsyncJob };
  const attempts = new Map<string, Attempt>();
  return {
    async run<O extends AsyncOperation>(operation: O, payload: OperationPayloads[O]): Promise<AsyncSubmission<O>> {
      const signature = JSON.stringify([operation, payload]);
      const attempt = attempts.get(signature) || { key: makeKey() };
      attempts.set(signature, attempt);
      if (attempt.running) return attempt.running as Promise<AsyncSubmission<O>>;
      if (attempt.accepted) return { accepted: true, job: attempt.accepted };
      const running = send(operation, payload, attempt.key);
      attempt.running = running;
      try {
        const result = await running;
        if (result.accepted) attempt.accepted = result.job;
        else attempts.delete(signature);
        return result;
      } finally { attempt.running = undefined; }
    },
    reconcile(jobs: AsyncJob[]) {
      const byId = new Map(jobs.map(job => [job.id, job]));
      for (const [signature, attempt] of attempts) {
        if (!attempt.accepted) continue;
        const job = byId.get(attempt.accepted.id);
        if (job?.status === "succeeded") attempts.delete(signature);
        else if (job) attempt.accepted = job;
      }
    },
    releaseReviewedFailure(job: AsyncJob) {
      if (!canReviewFailure(job)) return false;
      for (const [signature, attempt] of attempts) if (attempt.accepted?.id === job.id && !attempt.running) attempts.delete(signature);
      return true;
    },
  };
}

export type SavedReportResult = OperationResults["reports.meetup.save"];
