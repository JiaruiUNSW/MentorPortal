"use client";

import { useCallback, useState } from "react";
import { Plus, UsersRound } from "lucide-react";
import type { GroupDto, MenteeDto, ReportDto, ReportKind, TaskDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { mentorRequest } from "./api";
import { useMutation, usePagedResource, useResource } from "./hooks";
import { dateLabel, EmptyState, ErrorNotice, LoadingState, PageHeader, StatusMark } from "./ui";

export const reportLabels = { week1: "Week 1", meetup: "Meet-up", completion: "Completion" } as const;
export type ReportSelection = { group: GroupDto; kind: ReportKind; report?: ReportDto };

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

export function GroupsView({ groups, onReport, revision = 0 }: { groups: GroupDto[]; onReport: (selection: ReportSelection) => void; revision?: number }) {
  const rounds = [...new Set(groups.map(group => group.roundId))];
  const [round, setRound] = useState(rounds[0] || "");
  const [selected, setSelected] = useState(groups[0]?.id || "");
  const visible = groups.filter(group => group.roundId === round);
  const group = visible.find(item => item.id === selected) || visible[0];

  return <>
    <PageHeader title="My Groups" description="Your groups, sessions and reports.">
      <Field className="round-select">
        <FieldLabel htmlFor="current-round">Current round</FieldLabel>
        <NativeSelect id="current-round" value={round} onChange={event => setRound(event.target.value)} disabled={!rounds.length}>
          {rounds.map(item => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}
        </NativeSelect>
      </Field>
    </PageHeader>
    {!groups.length ? <EmptyState title="No groups assigned">Your assigned groups will appear here when they are ready.</EmptyState> : <>
      <ToggleGroup type="single" value={group?.id || ""} onValueChange={value => { if (value) setSelected(value); }} aria-label="Assigned groups" className="group-switcher" style={{ gridTemplateColumns: `repeat(${Math.min(visible.length, 3) || 1}, minmax(0, 1fr))` }}>
        {visible.map(item => <ToggleGroupItem key={item.id} value={item.id} aria-label={`Show ${item.title}`} className="group-choice">
          <UsersRound aria-hidden="true" strokeWidth={1.8} />
          <span className="group-choice-copy"><strong>{item.title.replace(/^Group\s+/i, "")}</strong><span><span>{item.type}</span><span className="group-choice-separator"> · </span><span>{item.menteeCount} mentees</span></span></span>
        </ToggleGroupItem>)}
      </ToggleGroup>
      {group ? <GroupDetail key={`${group.id}-${revision}`} groupId={group.id} onReport={onReport} /> : <EmptyState title="No groups in this round">Choose another round to see your groups.</EmptyState>}
    </>}
  </>;
}

function GroupDetail({ groupId, onReport }: { groupId: string; onReport: (selection: ReportSelection) => void }) {
  const load = useCallback(() => mentorRequest("groups.get", { groupId }), [groupId]);
  const loadMeetups = useCallback((cursor?: string) => mentorRequest("reports.list", { groupId, kind: "meetup", limit: 50, ...(cursor ? { cursor } : {}) }), [groupId]);
  const resource = useResource(load);
  const history = usePagedResource(loadMeetups);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  if (resource.loading && !resource.data) return <LoadingState label="Loading group details…" />;
  if (!resource.data) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  const { group, mentees, reports, tasks } = resource.data;
  const meetups = sortMeetups(history.data?.items || []);

  return <section className="group-detail" aria-label={`${group.title} details`}>
    <div className="group-detail-header"><h2>{group.title}</h2><p>{group.type} · {group.roundId}</p></div>
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
          <Button variant="outline" onClick={() => setAttendanceOpen(true)}>Record attendance</Button>
        </div>
        <div className="panel-table"><Table className="attendance-table">
          <TableHeader><TableRow><TableHead>Mentee</TableHead><TableHead>Attendance</TableHead></TableRow></TableHeader>
          <TableBody>{mentees.map(mentee => <TableRow key={mentee.id}><TableCell>{mentee.firstName} {mentee.lastName}</TableCell><TableCell><StatusMark complete={mentee.attended}>{mentee.attended ? "Attended" : mentee.attendanceRecorded ? "Not attended" : "Not recorded"}</StatusMark></TableCell></TableRow>)}</TableBody>
        </Table>{!mentees.length ? <EmptyState title="No mentees yet">Mentees will appear when assigned to this group.</EmptyState> : null}</div>
      </section>
      <section className="workspace-panel group-reports-panel" aria-labelledby="group-reports-heading">
        <h3 id="group-reports-heading">Reports</h3>
        <SingleReportRow kind="week1" group={group} report={reports.find(report => report.kind === "week1")} task={tasks.find(task => task.key === "report.week1")} onReport={onReport} />
        <section className="meetup-section" aria-labelledby="meetup-history-heading">
          <div className="meetup-section-header"><div><h3 id="meetup-history-heading">Meet-ups</h3><p>Record each session separately.</p></div><Button onClick={() => onReport({ group, kind: "meetup" })} disabled={!group.reportEnabled}><Plus data-icon="inline-start" />New meet-up</Button></div>
          {!group.reportEnabled ? <p className="form-hint">New reports are not available for this group.</p> : null}
          <ErrorNotice error={history.error} retry={history.reload} />
          {history.loading ? <LoadingState label="Loading meet-up history…" /> : meetups.length ? <MeetupHistory group={group} reports={meetups} onReport={onReport} /> : !history.error ? <EmptyState title="No meet-ups recorded">Use New meet-up to record the first session for this group.</EmptyState> : null}
          <ErrorNotice error={history.pageError} retry={history.more} />
          {history.data?.nextCursor ? <div className="load-more"><Button variant="outline" onClick={history.more} disabled={history.loadingMore}>{history.loadingMore ? "Loading…" : "Load more meet-ups"}</Button></div> : null}
        </section>
        <SingleReportRow kind="completion" group={group} report={reports.find(report => report.kind === "completion")} task={tasks.find(task => task.key === "report.completion")} onReport={onReport} />
      </section>
    </div>
    <Dialog open={attendanceOpen} onOpenChange={setAttendanceOpen}><DialogContent><DialogHeader><DialogTitle>Record attendance</DialogTitle><DialogDescription>{group.title} · {group.roundId}</DialogDescription></DialogHeader>{attendanceOpen ? <AttendanceForm group={group} mentees={mentees} saved={async () => { setAttendanceOpen(false); await resource.reload(); }} /> : null}</DialogContent></Dialog>
  </section>;
}

function SingleReportRow({ kind, group, report, task, onReport }: { kind: "week1" | "completion"; group: GroupDto; report?: ReportDto; task?: TaskDto; onReport: (selection: ReportSelection) => void }) {
  const state = reportState(report, task);
  return <div className="report-summary-row"><strong>{reportLabels[kind]}</strong><StatusMark complete={state.complete}>{state.label}</StatusMark><Button variant="outline" onClick={() => onReport({ group, kind, report })} disabled={!group.reportEnabled && !report}>{state.action}</Button></div>;
}

function MeetupHistory({ group, reports, onReport }: { group: GroupDto; reports: ReportDto[]; onReport: (selection: ReportSelection) => void }) {
  return <>
    <div className="meetup-history-desktop panel-table"><Table className="meetup-history-table"><TableHeader><TableRow><TableHead>Session</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{reports.map(report => {
      const state = reportState(report);
      return <TableRow key={report.id}><TableCell>{report.title}</TableCell><TableCell>{dateLabel(report.meetupDate)}</TableCell><TableCell><StatusMark complete={state.complete}>{state.label}</StatusMark></TableCell><TableCell><Button variant="link" onClick={() => onReport({ group, kind: "meetup", report })}>{state.action}</Button></TableCell></TableRow>;
    })}</TableBody></Table></div>
    <ul className="meetup-history-mobile">{reports.map(report => {
      const state = reportState(report);
      return <li key={report.id}><div className="session-identity"><strong>{report.title}</strong><span>{dateLabel(report.meetupDate)}</span></div><StatusMark complete={state.complete}>{state.label}</StatusMark><Button variant="outline" onClick={() => onReport({ group, kind: "meetup", report })}>{state.action}</Button></li>;
    })}</ul>
  </>;
}

function AttendanceForm({ group, mentees, saved }: { group: GroupDto; mentees: MenteeDto[]; saved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(mentees.map(mentee => [mentee.id, mentee.attendanceRecorded ? String(mentee.attended) : ""])));
  const mutation = useMutation();
  const changes = mentees.filter(mentee => values[mentee.id] !== "" && (!mentee.attendanceRecorded || values[mentee.id] !== String(mentee.attended)));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await mutation.run("attendance.save", { groupId: group.id, expectedVersion: group.version, entries: changes.map(mentee => ({ menteeId: mentee.id, expectedVersion: mentee.version, attended: values[mentee.id] === "true" })) });
    if (result) await saved();
  }
  return <form onSubmit={submit}><div>{mentees.map(mentee => <Field key={mentee.id} orientation="horizontal" className="attendance-edit-row"><FieldLabel htmlFor={`attendance-${mentee.id}`}>{mentee.firstName} {mentee.lastName}</FieldLabel><NativeSelect id={`attendance-${mentee.id}`} value={values[mentee.id]} disabled={mutation.pending || mutation.readOnly} onChange={event => setValues(value => ({ ...value, [mentee.id]: event.target.value }))}><NativeSelectOption value="" disabled>Not recorded</NativeSelectOption><NativeSelectOption value="true">Attended</NativeSelectOption><NativeSelectOption value="false">Not attended</NativeSelectOption></NativeSelect></Field>)}</div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="submit" disabled={mutation.pending || !changes.length || mutation.readOnly}>{mutation.pending ? "Saving attendance…" : "Save attendance"}</Button></div></form>;
}
