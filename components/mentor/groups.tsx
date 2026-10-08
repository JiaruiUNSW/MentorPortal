"use client";

import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import type { GroupDto, MenteeDto, ReportDto, ReportKind, TaskDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { mentorRequest } from "./api";
import { usePagedResource, useResource } from "./hooks";
import { JobStatusNotice, useAsyncJobs, useAsyncMutation } from "./async-jobs";
import { attendanceOverlay, blocksGroup, jobLabel, reportRows, type AttendanceJob, type ReportJob, type ReportRow } from "./async-state";
import { restoreAttendanceFailure } from "./async-recovery";
import { resolveGroupSelection, type GroupSelection } from "./group-directory";
import { dateLabel, EmptyState, ErrorNotice, LoadingState, PageHeader, StatusMark } from "./ui";

export const reportLabels = { week1: "Week 1", meetup: "Meet-up", completion: "Completion" } as const;
export type ReportSelection = { group: GroupDto; kind: ReportKind; report?: ReportDto; jobId?: string };

/** Session records are independent; the date/ID order never determines which record is edited. */
export function sortMeetups(reports: ReportDto[]) {
  return [...reports].sort((a, b) =>
    (b.meetupDate || "").localeCompare(a.meetupDate || "") ||
    (b.createdAt || "").localeCompare(a.createdAt || "") ||
    a.id.localeCompare(b.id),
  );
}

export function reportState(report?: ReportDto, task?: TaskDto) {
  const state = report?.submissionState || task?.submissionState || "not_started";
  return {
    complete: state === "submitted",
    label: state === "submitted" ? "Submitted" : state === "draft" ? "Draft" : state === "repair_required" ? "Needs update" : state === "unknown" ? "Not confirmed" : "Not started",
    action: state === "submitted" || state === "unknown" ? "View report" : report ? "Continue" : "Start report",
  };
}

export function GroupsView({ groups, selection, onSelectionChange, preferredGroupId, onReport, revision = 0 }: {
  groups: GroupDto[];
  selection: GroupSelection;
  onSelectionChange: (selection: GroupSelection) => void;
  preferredGroupId?: string;
  onReport: (selection: ReportSelection) => void;
  revision?: number;
}) {
  const { rounds, round, visible, group } = resolveGroupSelection(groups, selection, preferredGroupId);

  return <>
    <PageHeader title="My Groups" description="Your groups, sessions and reports.">
      <Field className="round-select">
        <FieldLabel htmlFor="current-round">Round</FieldLabel>
        <NativeSelect id="current-round" value={round} onChange={event => onSelectionChange({ round: event.target.value, groupId: groups.find(item => item.roundId === event.target.value)?.id || "" })} disabled={!rounds.length}>
          {rounds.map(item => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </PageHeader>
    {!groups.length ? <EmptyState title="No groups assigned">Your assigned groups will appear here when they are ready.</EmptyState> : <>
      <ToggleGroup type="single" value={group?.id || ""} onValueChange={value => { if (value) onSelectionChange({ round, groupId: value }); }} aria-label="Assigned groups" className="group-switcher">
        {visible.map(item => <ToggleGroupItem key={item.id} value={item.id} aria-label={`Show ${item.title}`} className="group-choice">
          <span className="group-choice-copy"><strong>{item.title}</strong><span><span>{item.type}</span><span className="group-choice-separator"> · </span><span>{item.menteeCount} mentees</span></span></span>
        </ToggleGroupItem>)}
      </ToggleGroup>
      {group ? <GroupDetail key={group.id} groupId={group.id} onReport={onReport} revision={revision} /> : <EmptyState title="No groups in this round">Choose another round to see your groups.</EmptyState>}
    </>}
  </>;
}

function GroupDetail({ groupId, onReport, revision }: { groupId: string; onReport: (selection: ReportSelection) => void; revision: number }) {
  const load = useCallback(() => mentorRequest("groups.get", { groupId }), [groupId]);
  const loadMeetups = useCallback((cursor?: string) => mentorRequest("reports.list", { groupId, kind: "meetup", limit: 50, ...(cursor ? { cursor } : {}) }), [groupId]);
  const resource = useResource(load, revision);
  const history = usePagedResource(loadMeetups, revision);
  const { jobs, releaseFailure } = useAsyncJobs();
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [attendanceJob, setAttendanceJob] = useState<AttendanceJob | undefined>();
  const [attendanceDraft, setAttendanceDraft] = useState<Record<string, string> | undefined>();
  const [attendanceEditor, setAttendanceEditor] = useState(0);
  if (resource.loading && !resource.data) return <LoadingState label="Loading group details…" />;
  if (!resource.data) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  const { reports, tasks } = resource.data;
  const { group, mentees, job: lastAttendanceJob, pendingIds } = attendanceOverlay(resource.data.group, resource.data.mentees, jobs);
  const currentAttendanceJob = attendanceJob ? jobs.find((job): job is AttendanceJob => job.id === attendanceJob.id && job.operation === "attendance.save") || attendanceJob : undefined;
  const blocked = jobs.some(job => job.groupId === groupId && blocksGroup(job));
  const meetups = reportRows(history.data?.items || [], jobs, groupId, "meetup");
  const singleReports = reportRows(reports.filter(report => report.kind !== "meetup"), jobs, groupId);
  function openAttendance(job?: AttendanceJob) { setAttendanceJob(job); setAttendanceDraft(undefined); setAttendanceEditor(value => value + 1); setAttendanceOpen(true); }
  async function reviewAttendance() {
    if (!currentAttendanceJob) return;
    const latest = await mentorRequest("groups.get", { groupId });
    const draft = restoreAttendanceFailure(currentAttendanceJob, latest);
    if (!releaseFailure(currentAttendanceJob.id)) throw new Error("This update’s status changed. Check its saved status before editing.");
    resource.setData(latest); setAttendanceDraft(draft); setAttendanceJob(undefined); setAttendanceEditor(value => value + 1);
  }

  return <section className="group-detail" aria-label={`${group.title} details`}>
    <div className="group-detail-header sr-only"><h2>{group.title}</h2><p>{group.type} · {group.roundId}</p></div>
    <ErrorNotice error={resource.error} retry={resource.reload} />
    <dl className="group-information" aria-label="Group information">
      <div><dt>Start date</dt><dd>{group.startDate ? dateLabel(group.startDate) : "Not provided"}</dd></div>
      <div><dt>MPL</dt><dd>{group.mplName.trim() || "Not assigned"}<span className="group-contact-email">{group.mplCommunicationEmail.trim() || "Email not provided"}</span></dd></div>
      <div><dt>Group format</dt><dd>{group.mode.trim() || "Not provided"}</dd></div>
      <div><dt>Status</dt><dd>{group.groupStatus === 0 ? "Upcoming" : group.groupStatus === 1 ? "Active" : group.groupStatus === 2 ? "Completed" : "Not confirmed"}</dd></div>
    </dl>
    <div className="group-detail-columns">
      <section className="workspace-panel attendance-panel" aria-labelledby="attendance-heading">
        <div className="panel-header attendance-toolbar">
          <div><h3 id="attendance-heading">Mentee attendance</h3><p>{group.attendanceUpdatedAt ? `Updated ${dateLabel(group.attendanceUpdatedAt)}` : "Your group’s current attendance"}</p></div>
          <Button variant="outline" size="sm" onClick={() => openAttendance(lastAttendanceJob && blocksGroup(lastAttendanceJob) ? lastAttendanceJob : undefined)} disabled={blocked && !(lastAttendanceJob && blocksGroup(lastAttendanceJob))}>{lastAttendanceJob && blocksGroup(lastAttendanceJob) ? "View attendance update" : "Record attendance"}</Button>
        </div>
        {lastAttendanceJob ? <p className="form-hint" role="status">Attendance update: {jobLabel(lastAttendanceJob)}{lastAttendanceJob.status !== "succeeded" ? <> · <Button variant="link" size="sm" onClick={() => openAttendance(lastAttendanceJob)}>View saved update</Button></> : null}</p> : null}
        <div className="panel-table"><Table className="attendance-table">
          <TableHeader><TableRow><TableHead>Mentee</TableHead><TableHead>Attendance</TableHead></TableRow></TableHeader>
          <TableBody>{mentees.map(mentee => <TableRow key={mentee.id}><TableCell>{mentee.firstName} {mentee.lastName}</TableCell><TableCell><StatusMark complete={mentee.attended && !pendingIds.has(mentee.id)}>{mentee.attended ? "Attended" : mentee.attendanceRecorded ? "Not attended" : "Not recorded"}{pendingIds.has(mentee.id) ? " · Pending sync" : ""}</StatusMark></TableCell></TableRow>)}</TableBody>
        </Table>{!mentees.length ? <EmptyState title="No mentees yet">Mentees will appear when assigned to this group.</EmptyState> : null}</div>
      </section>
      <section className="workspace-panel group-reports-panel" aria-labelledby="group-reports-heading">
        <h3 id="group-reports-heading">Reports</h3>
        <SingleReportRow kind="week1" group={group} row={singleReports.find(report => report.kind === "week1")} task={tasks.find(task => task.key === "report.week1")} onReport={onReport} />
        <section className="meetup-section" aria-labelledby="meetup-history-heading">
          <div className="meetup-section-header"><div><h3 id="meetup-history-heading">Meet-ups</h3><p>Record each session separately.</p></div><Button size="sm" onClick={() => onReport({ group, kind: "meetup" })} disabled={!group.reportEnabled}><Plus data-icon="inline-start" />New meet-up</Button></div>
          {!group.reportEnabled ? <p className="form-hint">New reports are not available for this group.</p> : null}
          <ErrorNotice error={history.error} retry={history.reload} />
          {history.loading && !meetups.length ? <LoadingState label="Loading meet-up history…" /> : meetups.length ? <MeetupHistory group={group} reports={meetups} onReport={onReport} /> : !history.error ? <EmptyState title="No meet-ups recorded">Use New meet-up to record the first session for this group.</EmptyState> : null}
          <ErrorNotice error={history.pageError} retry={history.more} />
          {history.data?.nextCursor ? <div className="load-more"><Button variant="outline" onClick={history.more} disabled={history.loadingMore}>{history.loadingMore ? "Loading…" : "Load more meet-ups"}</Button></div> : null}
        </section>
        <SingleReportRow kind="completion" group={group} row={singleReports.find(report => report.kind === "completion")} task={tasks.find(task => task.key === "report.completion")} onReport={onReport} />
      </section>
    </div>
    <Dialog open={attendanceOpen} onOpenChange={setAttendanceOpen}><DialogContent><DialogHeader><DialogTitle>{currentAttendanceJob ? "Attendance update" : "Record attendance"}</DialogTitle><DialogDescription>{group.title} · {group.roundId}</DialogDescription></DialogHeader>{attendanceOpen ? <AttendanceForm key={attendanceEditor} group={group} mentees={mentees} job={currentAttendanceJob} draft={attendanceDraft} onReview={reviewAttendance} saved={async accepted => { setAttendanceOpen(false); if (!accepted) await resource.reload(); }} /> : null}</DialogContent></Dialog>
  </section>;
}

export function reportRowState(row?: { report?: ReportDto; job?: ReportJob }, task?: TaskDto) {
  return row?.job ? { complete: false, label: jobLabel(row.job), action: "View update" } : reportState(row?.report, task);
}
function SingleReportRow({ kind, group, row, task, onReport }: { kind: "week1" | "completion"; group: GroupDto; row?: ReportRow; task?: TaskDto; onReport: (selection: ReportSelection) => void }) {
  const state = reportRowState(row, task);
  return <div className="report-summary-row"><strong>{reportLabels[kind]}</strong><StatusMark complete={state.complete}>{state.label}</StatusMark><Button variant="outline" size="sm" onClick={() => onReport({ group, kind, report: row?.report, jobId: row?.job?.id })} disabled={!group.reportEnabled && !row}>{state.action}</Button></div>;
}

function MeetupHistory({ group, reports, onReport }: { group: GroupDto; reports: ReportRow[]; onReport: (selection: ReportSelection) => void }) {
  return <>
    <div className="meetup-history-desktop panel-table"><Table className="meetup-history-table"><TableHeader><TableRow><TableHead>Session</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{reports.map(report => {
      const state = reportRowState(report);
      return <TableRow key={report.key}><TableCell>{report.title}</TableCell><TableCell>{dateLabel(report.date)}</TableCell><TableCell><StatusMark complete={state.complete}>{state.label}</StatusMark></TableCell><TableCell><Button variant="link" size="sm" onClick={() => onReport({ group, kind: "meetup", report: report.report, jobId: report.job?.id })}>{state.action}</Button></TableCell></TableRow>;
    })}</TableBody></Table></div>
    <ul className="meetup-history-mobile">{reports.map(report => {
      const state = reportRowState(report);
      return <li key={report.key}><div className="session-identity"><strong>{report.title}</strong><span>{dateLabel(report.date)}</span></div><StatusMark complete={state.complete}>{state.label}</StatusMark><Button variant="outline" size="sm" onClick={() => onReport({ group, kind: "meetup", report: report.report, jobId: report.job?.id })}>{state.action}</Button></li>;
    })}</ul>
  </>;
}

function AttendanceForm({ group, mentees, job, draft, onReview, saved }: { group: GroupDto; mentees: MenteeDto[]; job?: AttendanceJob; draft?: Record<string, string>; onReview: () => Promise<void>; saved: (accepted: boolean) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => draft || ({ ...Object.fromEntries(mentees.map(mentee => [mentee.id, mentee.attendanceRecorded ? String(mentee.attended) : ""])), ...Object.fromEntries(job?.intent.payload.entries.map(entry => [entry.menteeId, String(entry.attended)]) || []) }));
  const mutation = useAsyncMutation();
  const disabled = mutation.pending || mutation.readOnly || !mutation.ready || !!job;
  const changes = mentees.filter(mentee => values[mentee.id] !== "" && (!mentee.attendanceRecorded || values[mentee.id] !== String(mentee.attended)));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const result = await mutation.run("attendance.save", { groupId: group.id, expectedVersion: group.version, entries: changes.map(mentee => ({ menteeId: mentee.id, expectedVersion: mentee.version, attended: values[mentee.id] === "true" })) });
    if (result) await saved(result.accepted);
  }
  return <form onSubmit={submit}>{job ? <JobStatusNotice job={job} onReview={onReview} /> : draft ? <p className="form-hint">Your saved inputs are restored against the latest available record. Review them before submitting a new update.</p> : null}<div>{mentees.map(mentee => <Field key={mentee.id} orientation="horizontal" className="attendance-edit-row"><FieldLabel htmlFor={`attendance-${mentee.id}`}>{mentee.firstName} {mentee.lastName}</FieldLabel><NativeSelect id={`attendance-${mentee.id}`} value={values[mentee.id]} disabled={disabled} onChange={event => setValues(value => ({ ...value, [mentee.id]: event.target.value }))}><NativeSelectOption value="" disabled>Not recorded</NativeSelectOption><NativeSelectOption value="true">Attended</NativeSelectOption><NativeSelectOption value="false">Not attended</NativeSelectOption></NativeSelect></Field>)}</div><ErrorNotice error={mutation.error} />{!job ? <div className="form-actions"><Button type="submit" disabled={disabled || !changes.length}>{mutation.pending ? "Sending attendance…" : "Save attendance"}</Button></div> : null}</form>;
}
