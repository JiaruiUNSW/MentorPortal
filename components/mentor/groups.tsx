"use client";
import { useCallback, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { GroupDto, MenteeDto, ReportDto, ReportKind } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Field, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { mentorRequest } from "./api";
import { useMutation, useResource } from "./hooks";
import { dateLabel, EmptyState, ErrorNotice, Initials, LoadingState, PageHeader, StatusMark } from "./ui";

export const reportLabels = { week1: "Week 1", meetup: "Meet-up", completion: "Completion" } as const;
export type ReportSelection = { group: GroupDto; kind: ReportKind; report?: ReportDto };
function groupStatus(group: GroupDto) {
  if (group.groupStatus === 0) return "Upcoming";
  if (group.groupStatus === 1) return "Active";
  if (group.groupStatus === 2) return "Completed";
  return "Not confirmed";
}
export function GroupsView({ groups, onReport, revision = 0 }: { groups: GroupDto[]; onReport: (selection: ReportSelection) => void; revision?: number }) {
  const rounds = [...new Set(groups.map(group => group.roundId))];
  const [round, setRound] = useState(rounds[0] || "");
  const [selected, setSelected] = useState(groups[0]?.id || "");
  const visible = groups.filter(group => group.roundId === round);
  const group = visible.find(item => item.id === selected) || visible[0];
  return <><PageHeader title="My Groups" description="Your assigned groups and report tasks."><Field className="round-select"><FieldLabel htmlFor="current-round">Current round</FieldLabel><NativeSelect id="current-round" value={round} onChange={e => setRound(e.target.value)}>{rounds.map(item => <NativeSelectOption key={item} value={item}>{item}</NativeSelectOption>)}</NativeSelect></Field></PageHeader>
    {!groups.length ? <EmptyState title="No groups assigned">Your assigned groups will appear here when they are ready.</EmptyState> : <>
      <div className="data-table group-table-container"><Table className="group-table"><TableHeader><TableRow><TableHead>Group</TableHead><TableHead>Programme</TableHead><TableHead>Mentees</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{visible.map(item => <TableRow key={item.id} className={cn(group?.id === item.id && "selected-group")} onClick={() => setSelected(item.id)}><TableCell><button onClick={() => setSelected(item.id)} aria-pressed={group?.id === item.id} aria-label={`Show ${item.title}`}>{item.title}</button></TableCell><TableCell>{item.type}</TableCell><TableCell>{item.menteeCount} mentees</TableCell><TableCell><div className="status-cell"><StatusMark complete={item.groupStatus === 1} dot>{groupStatus(item)}</StatusMark><ChevronRight className="row-chevron" aria-hidden="true" /></div></TableCell></TableRow>)}</TableBody></Table></div>
      <div className="mobile-group-list">{visible.map(item => <button key={item.id} className={cn("mobile-group-button", group?.id === item.id && "is-selected")} aria-pressed={group?.id === item.id} onClick={() => setSelected(item.id)}><span><strong>{item.title}</strong><small>{item.type} · {item.menteeCount} mentees</small></span><StatusMark complete={item.groupStatus === 1} dot>{groupStatus(item)}</StatusMark><ChevronRight aria-hidden="true" /></button>)}</div>
      {group ? <GroupDetail key={`${group.id}-${revision}`} groupId={group.id} onReport={onReport} /> : <EmptyState title="No groups in this round">Choose another round to see your groups.</EmptyState>}
    </>}
  </>;
}
function GroupDetail({ groupId, onReport }: { groupId: string; onReport: (selection: ReportSelection) => void }) {
  const load = useCallback(() => mentorRequest("groups.get", { groupId }), [groupId]);
  const resource = useResource(load);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  if (resource.loading && !resource.data) return <LoadingState label="Loading group details…" />;
  if (!resource.data) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  const { group, mentees, reports, tasks } = resource.data;
  const meetup = reports.find(report => report.kind === "meetup");
  return <section className="group-detail" aria-label={`${group.title} details`}><div className="group-detail-header"><h2>{group.title}</h2><p>{group.roundId} · {group.type}</p></div><ErrorNotice error={resource.error} retry={resource.reload} /><div className="group-detail-columns">
    <section className="attendance-section"><div className="section-toolbar attendance-toolbar"><div className="attendance-heading"><h3>Mentee attendance</h3>{meetup?.meetupDate ? <p>Meet-up · {dateLabel(meetup.meetupDate)}</p> : null}</div><Button variant="outline" onClick={() => setAttendanceOpen(true)}>Record attendance</Button></div>
      <div className="data-table"><Table className="attendance-table"><TableHeader><TableRow><TableHead>Mentee</TableHead><TableHead>Attendance</TableHead></TableRow></TableHeader><TableBody>{mentees.map(mentee => <TableRow key={mentee.id}><TableCell><span className="person-cell"><Initials name={`${mentee.firstName} ${mentee.lastName}`} />{mentee.firstName} {mentee.lastName}</span></TableCell><TableCell><StatusMark complete={mentee.attended}>{mentee.attended ? "Attended" : mentee.attendanceRecorded ? "Not attended" : "Not recorded"}</StatusMark></TableCell></TableRow>)}</TableBody></Table>{!mentees.length ? <EmptyState title="No mentees yet">Mentees will appear when assigned to this group.</EmptyState> : null}</div>
    </section><section className="report-task-section"><div className="section-toolbar"><h3>Report tasks</h3></div><ul className="report-tasks">{(["week1", "meetup", "completion"] as ReportKind[]).map(kind => {
      const report = reports.find(item => item.kind === kind);
      const task = tasks.find(item => item.key === (kind === "meetup" ? "report.meetup1" : `report.${kind}`));
      const state = report?.submissionState || task?.submissionState || "not_started";
      const submitted = state === "submitted"; const draft = state === "draft"; const unknown = state === "unknown";
      return <li key={kind} className="report-task-row"><strong>{reportLabels[kind]}</strong><StatusMark complete={submitted}>{submitted ? "Submitted" : draft ? "Draft" : state === "repair_required" ? "Needs update" : unknown ? "Not confirmed" : "Not started"}</StatusMark><Button variant={draft ? "default" : "outline"} onClick={() => onReport({ group, kind, report })} disabled={!group.reportEnabled && !report}>{submitted || unknown ? "View report" : draft ? "Continue report" : "Start report"}</Button></li>;
    })}</ul></section></div>
    <Dialog open={attendanceOpen} onOpenChange={setAttendanceOpen}><DialogContent><DialogHeader><DialogTitle>Record attendance</DialogTitle><DialogDescription>{group.title} · {group.roundId}</DialogDescription></DialogHeader>{attendanceOpen ? <AttendanceForm group={group} mentees={mentees} saved={async () => { setAttendanceOpen(false); await resource.reload(); }} /> : null}</DialogContent></Dialog>
  </section>;
}
function AttendanceForm({ group, mentees, saved }: { group: GroupDto; mentees: MenteeDto[]; saved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(mentees.map(mentee => [mentee.id, mentee.attendanceRecorded ? String(mentee.attended) : ""])));
  const mutation = useMutation();
  const changes = mentees.filter(mentee => values[mentee.id] !== "" && (!mentee.attendanceRecorded || values[mentee.id] !== String(mentee.attended)));
  async function submit(event: React.FormEvent) { event.preventDefault(); const result = await mutation.run("attendance.save", { groupId: group.id, expectedVersion: group.version, entries: changes.map(mentee => ({ menteeId: mentee.id, expectedVersion: mentee.version, attended: values[mentee.id] === "true" })) }); if (result) await saved(); }
  return <form onSubmit={submit}><div>{mentees.map(mentee => <Field key={mentee.id} orientation="horizontal" className="attendance-edit-row"><FieldLabel htmlFor={`attendance-${mentee.id}`}>{mentee.firstName} {mentee.lastName}</FieldLabel><NativeSelect id={`attendance-${mentee.id}`} value={values[mentee.id]} disabled={mutation.pending} onChange={e => setValues(value => ({ ...value, [mentee.id]: e.target.value }))}><NativeSelectOption value="" disabled>Not recorded</NativeSelectOption><NativeSelectOption value="true">Attended</NativeSelectOption><NativeSelectOption value="false">Not attended</NativeSelectOption></NativeSelect></Field>)}</div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="submit" disabled={mutation.pending || !changes.length}>{mutation.pending ? "Saving attendance…" : "Save attendance"}</Button></div></form>;
}
