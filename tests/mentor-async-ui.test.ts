import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupDto, MenteeDto, OperationResults, ReportDto } from "../lib/contracts";
import type { AsyncJob } from "../lib/mentor-data/async-contract";
import type * as State from "../components/mentor/async-state";
import type * as Recovery from "../components/mentor/async-recovery";

const { attendanceOverlay, blocksGroup, confirmedJobReport, createAsyncSubmissionLedger, expenseReportId, jobLabel, mergeJobs, reconcileJobList, reportRows } = await import(new URL("../components/mentor/async-state.ts", import.meta.url).href) as typeof State;
const { restoreAttendanceFailure, reportIntentValues, restoreReportFailure } = await import(new URL("../components/mentor/async-recovery.ts", import.meta.url).href) as typeof Recovery;

const group: GroupDto = {
  id: "synthetic-group", version: "source-before", title: "Synthetic group", roundId: "Synthetic round", startDate: "2026-10-01", type: "Synthetic", mode: "In person", groupStatus: 1,
  reportEnabled: true, mplName: "", mplCommunicationEmail: "", menteeCount: 2, attendedCount: 0, week1Reports: 0, meetupReports: 0, completionReports: 0,
  firstAttendanceUpdatedAt: null, attendanceUpdatedAt: null, week1ReportedAt: null, firstMeetupReportedAt: null, secondMeetupReportedAt: null, completedAt: null,
};
const mentees: MenteeDto[] = ["a", "b"].map(id => ({ id, version: `before-${id}`, firstName: "Synthetic", lastName: id, gender: "", nationality: "", under18: "", visa: "", program: "", attended: false, attendanceRecorded: true }));
const base = { id: "job-a", groupId: group.id, status: "queued" as const, requestId: "request-a", createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", attachments: [], canRetry: false };
function attendanceJob(): State.AttendanceJob {
  return { ...base, operation: "attendance.save", intent: { operation: "attendance.save", payload: { groupId: group.id, expectedVersion: group.version, entries: [{ menteeId: "a", expectedVersion: "before-a", attended: true }] } } };
}
function meetupJob(id = "job-a"): Extract<State.ReportJob, { operation: "reports.meetup.save" }> {
  return { ...base, id, clientRecordId: `pending_${id}`, operation: "reports.meetup.save", intent: { operation: "reports.meetup.save", payload: { groupId: group.id, title: `Synthetic ${id}`, meetupDate: "2026-10-08", attendance: 2, description: "Synthetic preserved notes", isUseGC: true, isRequiredSC: false, submit: true, attachmentIds: ["synthetic-photo"] } }, attachments: [{ id: "synthetic-photo", fileName: "synthetic.png", mimeType: "image/png", sizeBytes: 68, parentKind: "meetupReport", parentId: null, groupId: group.id }] };
}
function report(id = "source-report"): ReportDto {
  return { id, version: "source-confirmed", kind: "meetup", groupId: group.id, title: "Confirmed synthetic activity", createdAt: base.createdAt, modifiedAt: base.updatedAt, reviewStatus: "submitted", submissionState: "submitted", meetupDate: "2026-10-08", isUseGC: true, attachments: [] };
}
function successfulMeetup(): ReturnType<typeof meetupJob> {
  return { ...meetupJob(), status: "succeeded", updatedAt: "2026-10-08T00:00:04.000Z", result: { report: report(), group: { ...group, version: "after" } } };
}

test("accepted attendance overlays entered booleans without inventing source versions", () => {
  const next = attendanceOverlay(group, mentees, [attendanceJob()]);
  assert.equal(next.mentees[0].attended, true);
  assert.equal(next.mentees[0].version, "before-a");
  assert.equal(next.group.version, "source-before");
  assert.deepEqual([...next.pendingIds], ["a"]);
  assert.equal(mentees[0].attended, false);
});

test("failed and uncertain attendance restore source values while preserving the attempted input", () => {
  for (const status of ["failed", "needs_review"] as const) {
    const job = { ...attendanceJob(), status };
    const next = attendanceOverlay(group, mentees, [job]);
    assert.equal(next.mentees[0].attended, false);
    assert.equal(next.job?.intent.payload.entries[0].attended, true);
    assert.equal(next.pendingIds.size, 0);
  }
});

test("successful attendance applies real result versions, but does not replace a later source snapshot", () => {
  const job: State.AttendanceJob = { ...attendanceJob(), status: "succeeded", result: { group: { ...group, version: "source-after" }, mentees: mentees.map(item => ({ ...item, attended: true, version: `after-${item.id}` })) } };
  assert.equal(attendanceOverlay(group, mentees, [job]).mentees[0].version, "after-a");
  assert.equal(attendanceOverlay({ ...group, version: "source-even-later" }, mentees, [job]).mentees[0].version, "before-a");
  assert.equal(attendanceOverlay({ ...group, id: "other-group" }, mentees, [job]).job, undefined);
});

test("new reports stay independent UI jobs with intact payload and files, never fabricated source records", () => {
  const jobs = [meetupJob("one"), meetupJob("two")];
  const rows = reportRows([], jobs, group.id, "meetup");
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.key)), new Set(["pending_one", "pending_two"]));
  assert.ok(rows.every(row => !row.report));
  assert.equal(rows[0].job?.attachments[0].fileName, "synthetic.png");
  assert.equal(reportRows([], jobs, "other-group").length, 0);
});

test("pending edit targets only its exact report and failed inputs stay readable", () => {
  const target = { ...report(), version: "before-edit" };
  const untouched = report("another-report");
  const job = meetupJob(); job.intent.payload.reportId = target.id; job.intent.payload.expectedVersion = target.version;
  job.status = "failed";
  const rows = reportRows([target, untouched], [job], group.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.key === target.id)?.job?.id, job.id);
  assert.equal(rows.find(row => row.key === untouched.id)?.report, untouched);
  assert.equal(jobLabel(job), "Sync failed");
});

test("completion replaces the UI-only ID with the real report once, preserving later source values", () => {
  const job = successfulMeetup();
  const rows = reportRows([], [job], group.id);
  assert.deepEqual(rows.map(row => row.key), ["source-report"]);
  assert.equal(rows[0].report?.version, "source-confirmed");
  assert.equal(rows[0].job, undefined);
  const later = { ...report(), version: "later", title: "Later source edit" };
  assert.equal(reportRows([later], [job], group.id)[0].report?.title, later.title);
});

test("expense submission stays unavailable for pending, failed, unknown or UI-only report IDs", () => {
  assert.equal(expenseReportId(confirmedJobReport(meetupJob())), null);
  assert.equal(expenseReportId(confirmedJobReport({ ...meetupJob(), status: "failed" })), null);
  assert.equal(expenseReportId({ ...report(), id: "pending_job-a" }), null);
  assert.equal(expenseReportId({ ...report(), submissionState: "unknown" }), null);
  assert.equal(expenseReportId({ ...report(), isUseGC: false }), null);
  assert.equal(expenseReportId(confirmedJobReport(successfulMeetup())), "source-report");
});

test("queued, running and needs-review block duplicate group writes; definite failure releases the lane", () => {
  for (const status of ["queued", "running", "needs_review"] as const) assert.equal(blocksGroup({ ...meetupJob(), status }), true);
  for (const status of ["succeeded", "failed"] as const) assert.equal(blocksGroup({ ...meetupJob(), status }), false);
});

test("stale polls cannot revert success while a newer explicit safe retry can replace failure", () => {
  const success = successfulMeetup();
  assert.equal(mergeJobs([success], [meetupJob()])[0].status, "succeeded");
  const failed = { ...meetupJob(), status: "failed" as const, updatedAt: "2026-10-08T00:00:04.000Z" };
  const retried = { ...meetupJob(), updatedAt: "2026-10-08T00:00:05.000Z" };
  assert.equal(mergeJobs([failed], [retried])[0].status, "queued");
});

test("authoritative owner-scoped listing drops inaccessible jobs but preserves an acceptance racing the read", () => {
  const old = meetupJob("old"); const accepted = meetupJob("accepted-now");
  const result = reconcileJobList([old, accepted], [], new Set([accepted.id]));
  assert.deepEqual(result.map(job => job.id), [accepted.id]);
  assert.deepEqual(reconcileJobList(result, [], new Set()), []);
});

test("an uncertain response reuses the original key and a confirmed success allows a deliberate later request", async () => {
  const keys: string[] = []; let serial = 0; let fail = true;
  const ledger = createAsyncSubmissionLedger(async (_operation, _payload, key) => {
    keys.push(key); if (fail) { fail = false; throw new Error("Synthetic lost response"); }
    return { accepted: true, job: meetupJob() };
  }, () => `key-${++serial}`);
  const payload = meetupJob().intent.payload;
  await assert.rejects(ledger.run("reports.meetup.save", payload), /lost response/);
  await ledger.run("reports.meetup.save", payload);
  await ledger.run("reports.meetup.save", payload);
  assert.deepEqual(keys, ["key-1", "key-1"]);
  ledger.reconcile([successfulMeetup()]);
  await ledger.run("reports.meetup.save", payload);
  assert.deepEqual(keys, ["key-1", "key-1", "key-2"]);
});

test("concurrent identical clicks dispatch once and failed accepted jobs are never silently re-enqueued", async () => {
  let finish: (value: { accepted: true; job: AsyncJob }) => void = () => {};
  const pending = new Promise<{ accepted: true; job: AsyncJob }>(resolve => { finish = resolve; });
  let calls = 0;
  const ledger = createAsyncSubmissionLedger(async () => { calls++; return pending; }, () => "same-key");
  const payload = meetupJob().intent.payload;
  const first = ledger.run("reports.meetup.save", payload); const second = ledger.run("reports.meetup.save", payload);
  assert.equal(calls, 1);
  finish({ accepted: true, job: meetupJob() }); await Promise.all([first, second]);
  ledger.reconcile([{ ...meetupJob(), status: "failed", canRetry: true }]);
  const result = await ledger.run("reports.meetup.save", payload);
  assert.equal(calls, 1); assert.equal(result.accepted && result.job.status, "failed");
});

test("different Portal instances never share saved request keys or accepted jobs", async () => {
  const keys: string[] = [];
  const send = async (_operation: unknown, _payload: unknown, key: string) => { keys.push(key); return { accepted: true as const, job: meetupJob() }; };
  const first = createAsyncSubmissionLedger(send, () => "account-one-key");
  const second = createAsyncSubmissionLedger(send, () => "account-two-key");
  await first.run("reports.meetup.save", meetupJob().intent.payload);
  await second.run("reports.meetup.save", meetupJob().intent.payload);
  assert.deepEqual(keys, ["account-one-key", "account-two-key"]);
});

test("original synchronous results are returned without a queued overlay", async () => {
  const expected = { group, mentees };
  const ledger = createAsyncSubmissionLedger(async <O extends import("../lib/mentor-data/async-contract").AsyncOperation>() => ({ accepted: false as const, data: expected as OperationResults[O] }));
  const result = await ledger.run("attendance.save", attendanceJob().intent.payload);
  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.data, expected);
});

const detail = (reports: ReportDto[] = []): OperationResults["groups.get"] => ({ group, mentees, reports, expenses: [], tasks: [] });
test("terminal failure recovery restores notes/files separately from current source IDs and versions", () => {
  const job = { ...meetupJob(), status: "failed" as const };
  job.intent.payload.reportId = "source-report"; job.intent.payload.expectedVersion = "old";
  const current = { ...report(), version: "new", submissionState: "draft" as const };
  assert.equal(restoreReportFailure(job, detail([current])), current);
  const values = reportIntentValues(job);
  assert.equal(values.description, "Synthetic preserved notes");
  assert.equal(values.id, undefined); assert.equal(values.version, undefined);
  assert.equal(job.attachments[0].fileName, "synthetic.png");
});

test("version-conflict review waits for cache refresh instead of recycling an unchanged ETag", () => {
  const error = { code: "VERSION_CONFLICT" as const, message: "Synthetic conflict", retryable: false };
  const attendance = { ...attendanceJob(), status: "failed" as const, error };
  assert.throws(() => restoreAttendanceFailure(attendance, detail()), /still refreshing/);
  const restored = restoreAttendanceFailure(attendance, { ...detail(), group: { ...group, version: "refreshed" } });
  assert.equal(restored.a, "true");
  const job = { ...meetupJob(), status: "failed" as const, error };
  job.intent.payload.reportId = "source-report"; job.intent.payload.expectedVersion = "old";
  assert.throws(() => restoreReportFailure(job, detail([{ ...report(), version: "old", submissionState: "draft" }])), /still refreshing/);
});

test("uncertain, active and safely retryable jobs cannot become a new edited intent", () => {
  for (const status of ["queued", "running", "needs_review", "succeeded"] as const) assert.throws(() => restoreReportFailure({ ...meetupJob(), status }, detail()), /cannot be replaced/);
  assert.throws(() => restoreReportFailure({ ...meetupJob(), status: "failed", canRetry: true }, detail()), /cannot be replaced/);
  const job = { ...meetupJob(), status: "failed" as const }; job.intent.payload.reportId = "missing";
  assert.throws(() => restoreReportFailure(job, detail()), /no longer available/);
});

test("only explicit reviewed terminal failure retires the old accepted key", async () => {
  const keys: string[] = []; let serial = 0;
  const job = { ...meetupJob(), status: "failed" as const };
  const ledger = createAsyncSubmissionLedger(async (_operation, _payload, key) => { keys.push(key); return { accepted: true, job }; }, () => `key-${++serial}`);
  const payload = job.intent.payload;
  await ledger.run("reports.meetup.save", payload);
  assert.equal(ledger.releaseReviewedFailure({ ...job, status: "needs_review" }), false);
  assert.equal(ledger.releaseReviewedFailure({ ...job, canRetry: true }), false);
  await ledger.run("reports.meetup.save", payload);
  assert.deepEqual(keys, ["key-1"]);
  assert.equal(ledger.releaseReviewedFailure(job), true);
  await ledger.run("reports.meetup.save", payload);
  assert.deepEqual(keys, ["key-1", "key-2"]);
});
