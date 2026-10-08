import type { OperationResults, ReportDto } from "@/lib/contracts";
import type { AttendanceJob, ReportJob } from "./async-state";

function requireTerminalFailure(job: AttendanceJob | ReportJob, detail: OperationResults["groups.get"]) {
  if (job.status !== "failed" || job.canRetry) throw new Error("This saved update cannot be replaced. Use its available status or retry action.");
  if (job.groupId !== detail.group.id) throw new Error("The latest record does not belong to this group.");
}

export function restoreAttendanceFailure(job: AttendanceJob, detail: OperationResults["groups.get"]) {
  requireTerminalFailure(job, detail);
  if (job.error?.code === "VERSION_CONFLICT" && detail.group.version === job.intent.payload.expectedVersion && job.intent.payload.entries.every(entry => detail.mentees.find(mentee => mentee.id === entry.menteeId)?.version === entry.expectedVersion)) throw new Error("The cached record is still refreshing after a version conflict. Try Review and edit again shortly.");
  const entries = new Map(job.intent.payload.entries.map(entry => [entry.menteeId, String(entry.attended)]));
  return Object.fromEntries(detail.mentees.map(mentee => [mentee.id, entries.get(mentee.id) ?? (mentee.attendanceRecorded ? String(mentee.attended) : "")]));
}

/** Restore entered fields only; identifiers and versions always come from the latest available record. */
export function reportIntentValues(job: ReportJob): Partial<ReportDto> {
  const payload = job.intent.payload;
  if (job.operation === "reports.week1.save") return { question: job.intent.payload.question, flagComment: job.intent.payload.flagComment };
  if (job.operation === "reports.completion.save") return { keyTakeaways: job.intent.payload.keyTakeaways, mostHelpful: job.intent.payload.mostHelpful, isJointAgain: job.intent.payload.isJointAgain, flagComment: job.intent.payload.flagComment };
  // Keep UI-only job identities out of data passed to the report editor.
  return { title: job.intent.payload.title, otherGroup: job.intent.payload.otherGroup, meetupDate: job.intent.payload.meetupDate, attendance: job.intent.payload.attendance, description: job.intent.payload.description, isUseGC: job.intent.payload.isUseGC, isRequiredSC: job.intent.payload.isRequiredSC, scComment: job.intent.payload.scComment, ...(payload.submit === false ? { submissionState: "draft" } : {}) };
}

export function restoreReportFailure(job: ReportJob, detail: OperationResults["groups.get"]): ReportDto | undefined {
  requireTerminalFailure(job, detail);
  if (!detail.group.reportEnabled) throw new Error("Reports are no longer enabled for this group.");
  const kind = job.operation === "reports.week1.save" ? "week1" : job.operation === "reports.meetup.save" ? "meetup" : "completion";
  const report = job.intent.payload.reportId ? detail.reports.find(item => item.id === job.intent.payload.reportId && item.kind === kind) : kind !== "meetup" ? detail.reports.find(item => item.kind === kind) : undefined;
  if (job.intent.payload.reportId && !report) throw new Error("This report is no longer available. Your attempted values remain in the saved update.");
  if (report && (report.submissionState === "submitted" || report.submissionState === "unknown" || report.reviewStatus === "accepted")) throw new Error("The latest report is already submitted or cannot be edited. Close this update to view its current record.");
  if (job.error?.code === "VERSION_CONFLICT" && report && report.version === job.intent.payload.expectedVersion) throw new Error("The cached report is still refreshing after a version conflict. Try Review and edit again shortly.");
  return report;
}
