"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { AttachmentDto, ExpenseDto, GroupDto, ReportDto, ReportKind } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Attachments } from "./attachments";
import { mentorRequest } from "./api";
import { CheckField, TextField } from "./form-fields";
import { reportLabels, reportRowState, type ReportSelection } from "./groups";
import { useMutation, usePagedResource, useResource } from "./hooks";
import { JobStatusNotice, useAsyncJobs, useAsyncMutation } from "./async-jobs";
import { blocksGroup, confirmedJobReport, expenseReportId, isReportJob, jobReportKind, jobReportTitle, reportRows, type ReportJob, type ReportRow } from "./async-state";
import type { AsyncSubmission } from "./async-client";
import { reportIntentValues, restoreReportFailure } from "./async-recovery";
import { useSession } from "./session";
import { dateLabel, EmptyState, ErrorNotice, humanize, LoadingState, PageHeader, StatusMark, SuccessNotice } from "./ui";

export function ReportsView({ groups, onReport, revision = 0 }: { groups: GroupDto[]; onReport: (selection: ReportSelection) => void; revision?: number }) {
  const [groupId, setGroupId] = useState(groups[0]?.id || "");
  const [kind, setKind] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const group = groups.find(item => item.id === groupId);
  const load = useCallback((cursor?: string) => groupId ? mentorRequest("reports.list", { groupId, ...(kind ? { kind: kind as ReportKind } : {}), ...(cursor ? { cursor } : {}), limit: 25 }) : Promise.resolve({ items: [] as ReportDto[], nextCursor: null }), [groupId, kind]);
  const resource = usePagedResource(load, revision);
  const { jobs } = useAsyncJobs();
  const blocked = jobs.some(job => job.groupId === groupId && blocksGroup(job));
  const reports = reportRows(resource.data?.items || [], jobs, groupId, kind ? kind as ReportKind : undefined);
  function openReport(row: ReportRow) { if (group) onReport({ group, kind: row.kind, report: row.report, jobId: row.job?.id }); }

  return <>
    <PageHeader title="Reports" description="Prepare and review your mentoring reports.">
      <div className="page-actions"><Button variant="outline" onClick={() => setNewOpen(true)} disabled={!group?.reportEnabled}>Start a report</Button><Button onClick={() => { if (group) onReport({ group, kind: "meetup" }); }} disabled={!group?.reportEnabled}><Plus data-icon="inline-start" />New meet-up</Button></div>
    </PageHeader>
    <section className="report-library workspace-panel" aria-label="Report history">
      <div className="filter-row">
        <Field><FieldLabel htmlFor="reports-group">Group</FieldLabel><NativeSelect id="reports-group" disabled={!groups.length} value={groupId} onChange={event => setGroupId(event.target.value)}>{groups.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.title}</NativeSelectOption>)}</NativeSelect></Field>
        <Field><FieldLabel htmlFor="reports-kind">Report type</FieldLabel><NativeSelect id="reports-kind" value={kind} onChange={event => setKind(event.target.value)}><NativeSelectOption value="">All report types</NativeSelectOption>{Object.entries(reportLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>
      </div>
      <ErrorNotice error={resource.error} retry={resource.reload} />
      {blocked ? <p className="form-hint">This group has an update awaiting sync or review. Its saved details are available below.</p> : null}
      {resource.loading && !reports.length ? <LoadingState label="Loading reports…" /> : reports.length ? <>
        <div className="report-library-desktop panel-table"><Table><TableHeader><TableRow><TableHead>Report</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{reports.map(report => {
          const state = reportRowState(report);
          return <TableRow key={report.key}><TableCell><strong>{report.kind === "meetup" ? report.title : reportLabels[report.kind]}</strong><span className="cell-secondary">{report.kind === "meetup" ? "Meet-up" : report.title}</span></TableCell><TableCell>{dateLabel(report.date)}</TableCell><TableCell><StatusMark complete={state.complete}>{state.label}</StatusMark></TableCell><TableCell><Button variant="outline" onClick={() => openReport(report)}>{state.action}</Button></TableCell></TableRow>;
        })}</TableBody></Table></div>
        <ul className="report-library-mobile">{reports.map(report => {
          const state = reportRowState(report);
          return <li key={report.key}><div className="session-identity"><strong>{report.kind === "meetup" ? report.title : reportLabels[report.kind]}</strong><span>{reportLabels[report.kind]} · {dateLabel(report.date)}</span></div><StatusMark complete={state.complete}>{state.label}</StatusMark><Button variant="outline" onClick={() => openReport(report)}>{state.action}</Button></li>;
        })}</ul>
      </> : !resource.error ? <EmptyState title={groups.length ? "No reports here yet" : "No groups assigned"}>{groups.length ? "Start a report for this group, or choose another filter." : "Your reports will appear when a mentoring group is assigned to you."}</EmptyState> : null}
      <ErrorNotice error={resource.pageError} retry={resource.more} />
      {resource.data?.nextCursor ? <div className="load-more"><Button variant="outline" onClick={resource.more} disabled={resource.loadingMore}>{resource.loadingMore ? "Loading…" : "Load more reports"}</Button></div> : null}
    </section>
    <Dialog open={newOpen} onOpenChange={setNewOpen}><DialogContent><DialogHeader><DialogTitle>Start a report</DialogTitle><DialogDescription>Choose the group and report you want to prepare.</DialogDescription></DialogHeader>{newOpen ? <NewReportChooser groups={groups} defaultGroupId={groupId} start={selection => { setNewOpen(false); onReport(selection); }} /> : null}</DialogContent></Dialog>
  </>;
}
function NewReportChooser({ groups, defaultGroupId, start }: { groups: GroupDto[]; defaultGroupId: string; start: (selection: ReportSelection) => void }) {
  const [groupId, setGroupId] = useState(defaultGroupId || groups[0]?.id || ""); const [kind, setKind] = useState<ReportKind>("week1"); const [error, setError] = useState<Error | null>(null); const [pending, setPending] = useState(false);
  const { jobs } = useAsyncJobs();
  const blocked = jobs.some(job => job.groupId === groupId && blocksGroup(job));
  async function submit(event: React.FormEvent) { event.preventDefault(); setPending(true); setError(null); try { const result = await mentorRequest("groups.get", { groupId }); start({ group: result.group, kind, report: kind === "meetup" ? undefined : result.reports.find(report => report.kind === kind && report.submissionState !== "submitted") || result.reports.find(report => report.kind === kind) }); } catch (e) { setError(e as Error); setPending(false); } }
  return <form onSubmit={submit}><FieldGroup><Field><FieldLabel htmlFor="new-report-group">Group</FieldLabel><NativeSelect id="new-report-group" value={groupId} onChange={e => setGroupId(e.target.value)} disabled={pending}>{groups.filter(group => group.reportEnabled).map(group => <NativeSelectOption key={group.id} value={group.id}>{group.title}</NativeSelectOption>)}</NativeSelect></Field><Field><FieldLabel htmlFor="new-report-kind">Report type</FieldLabel><NativeSelect id="new-report-kind" value={kind} onChange={e => setKind(e.target.value as ReportKind)} disabled={pending}>{Object.entries(reportLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></Field>{blocked ? <p className="form-hint">You can prepare another report now. Submission remains unavailable until this group’s saved update is resolved.</p> : null}<ErrorNotice error={error} /></FieldGroup><div className="form-actions"><Button disabled={pending || !groupId}>{pending ? "Opening…" : "Continue"}</Button></div></form>;
}

export function ReportDialog({ selection, close, onSaved }: { selection: ReportSelection | null; close: () => void; onSaved: () => void }) {
  return <Dialog open={!!selection} onOpenChange={open => { if (!open) close(); }}><DialogContent className="report-dialog">{selection ? <ReportWorkflow key={`${selection.group.id}-${selection.kind}-${selection.jobId || selection.report?.id || "new"}`} selection={selection} onSaved={onSaved} /> : null}</DialogContent></Dialog>;
}
function ReportWorkflow({ selection, onSaved }: { selection: ReportSelection; onSaved: () => void }) {
  const { jobs, ready, error, refresh, releaseFailure } = useAsyncJobs();
  const [latestReport, setLatestReport] = useState(selection.report);
  const [latestGroup, setLatestGroup] = useState(selection.group);
  const [restored, setRestored] = useState<ReportJob | undefined>();
  const [jobId, setJobId] = useState(selection.jobId);
  const [expense, setExpense] = useState<{ report?: ReportDto; jobId?: string; justSubmitted: boolean } | null>(null);
  const job = jobs.find((item): item is ReportJob => item.id === jobId && isReportJob(item));
  const confirmed = confirmedJobReport(job);
  const expenseJob = expense?.jobId ? jobs.find((item): item is ReportJob => item.id === expense.jobId && isReportJob(item)) : undefined;
  const expenseReport = expense?.report || confirmedJobReport(expenseJob);
  const heading = useRef<HTMLHeadingElement>(null);
  const expenseIdentity = expense?.jobId || expense?.report?.id;

  useEffect(() => {
    if (!expenseIdentity) return;
    heading.current?.closest('[role="dialog"]')?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [expenseIdentity]);

  function openExpense(report: ReportDto, justSubmitted = false) {
    setLatestReport(report);
    setExpense({ report, justSubmitted });
  }
  function accepted(job: ReportJob) {
    setJobId(job.id); setRestored(undefined);
    if (job.operation === "reports.meetup.save" && job.intent.payload.submit !== false && job.intent.payload.isUseGC) setExpense({ jobId: job.id, justSubmitted: false });
  }
  async function reviewFailure() {
    if (!job) return;
    const latest = await mentorRequest("groups.get", { groupId: job.groupId });
    const editable = restoreReportFailure(job, latest);
    if (!releaseFailure(job.id)) throw new Error("This update’s status changed. Check its saved status before editing.");
    setLatestGroup(latest.group); setLatestReport(editable); setRestored(job); setJobId(undefined);
  }

  return <>
    <DialogHeader><DialogTitle ref={heading} tabIndex={-1}>{expense ? "Expense report" : `${reportLabels[selection.kind]} report`}</DialogTitle><DialogDescription>{selection.group.title} · {expenseReport?.title || (job ? jobReportTitle(job) : latestReport?.title) || selection.group.roundId}</DialogDescription></DialogHeader>
    {expense ? <div className="form-stack">
      {expense.justSubmitted ? <SuccessNotice>Your meet-up report has been submitted.</SuccessNotice> : null}
      {expenseJob ? <JobStatusNotice job={expenseJob} /> : null}
      <ExpenseSection group={selection.group} report={expenseReport} onSaved={() => { setExpense(value => value ? { ...value, justSubmitted: false } : null); onSaved(); }} />
      <div className="form-actions"><Button variant="outline" onClick={() => setExpense(null)}>Back to meet-up report</Button></div>
    </div> : job && !confirmed ? <QueuedReport job={job} group={selection.group} onExpense={() => setExpense({ jobId: job.id, justSubmitted: false })} onReview={reviewFailure} /> : jobId && !job ? ready ? <ErrorNotice error={error || new Error("This saved update is no longer available for this account or group.")} retry={() => { void refresh(); }} /> : <LoadingState label="Loading your saved update…" /> : <ReportEditor key={confirmed?.id || restored?.id || "editor"} selection={{ ...selection, group: latestGroup, report: confirmed || latestReport }} restored={restored} onSaved={onSaved} onExpense={openExpense} onAccepted={accepted} />}
  </>;
}
function QueuedReport({ job, group, onExpense, onReview }: { job: ReportJob; group: GroupDto; onExpense: () => void; onReview: () => Promise<void> }) {
  const fields = job.operation === "reports.week1.save" ? [["Support and questions", job.intent.payload.question], ["Additional comments", job.intent.payload.flagComment]]
    : job.operation === "reports.completion.save" ? [["Key takeaways", job.intent.payload.keyTakeaways], ["What helped most", job.intent.payload.mostHelpful], ["Interested in joining again", job.intent.payload.isJointAgain ? "Yes" : "No"], ["Additional comments", job.intent.payload.flagComment]]
    : [["Activity", job.intent.payload.title], ["Meet-up date", dateLabel(job.intent.payload.meetupDate)], ["Attendance", String(job.intent.payload.attendance)], ["Description and location", job.intent.payload.description], ["Collaborating groups", job.intent.payload.otherGroup], ["Gift card used", job.intent.payload.isUseGC ? "Yes" : "No"], ["Special consideration", job.intent.payload.isRequiredSC ? job.intent.payload.scComment || "Requested" : "Not requested"]];
  return <div className="form-stack"><JobStatusNotice job={job} onReview={onReview} /><dl className="record-details">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <Attachments context={{ parentKind: "meetupReport", groupId: group.id, ...(job.intent.payload.reportId ? { parentId: job.intent.payload.reportId } : {}) }} files={job.attachments} readOnly />
    {job.operation === "reports.meetup.save" && job.intent.payload.isUseGC && job.intent.payload.submit !== false ? <div className="form-actions"><Button onClick={onExpense}>Prepare expense report</Button></div> : null}
  </div>;
}
function ReportEditor({ selection, restored, onSaved, onExpense, onAccepted }: { selection: ReportSelection; restored?: ReportJob; onSaved: () => void; onExpense: (report: ReportDto, justSubmitted?: boolean) => void; onAccepted: (job: ReportJob) => void }) {
  const { session } = useSession(); const { group, kind } = selection;
  const [current, setCurrent] = useState(selection.report); const [version, setVersion] = useState(selection.report?.version);
  const initial = restored ? reportIntentValues(restored) : current;
  const [question, setQuestion] = useState(initial?.question || ""); const [flag, setFlag] = useState(initial?.flagComment || "");
  const [title, setTitle] = useState(initial?.title || ""); const [otherGroup, setOtherGroup] = useState(initial?.otherGroup || "");
  const [date, setDate] = useState(initial?.meetupDate || ""); const [attendance, setAttendance] = useState(String(initial?.attendance ?? "")); const [description, setDescription] = useState(initial?.description || "");
  const [giftCard, setGiftCard] = useState(initial?.isUseGC || false); const [special, setSpecial] = useState(initial?.isRequiredSC || false); const [specialComment, setSpecialComment] = useState(initial?.scComment || "");
  const [takeaways, setTakeaways] = useState(initial?.keyTakeaways || ""); const [helpful, setHelpful] = useState(initial?.mostHelpful || ""); const [again, setAgain] = useState(initial?.isJointAgain ?? true);
  const [files, setFiles] = useState<AttachmentDto[]>(restored?.attachments || current?.attachments || []); const [uploading, setUploading] = useState(false); const [saved, setSaved] = useState(""); const [localError, setLocalError] = useState<Error | null>(null);
  const { jobs } = useAsyncJobs();
  const blockingJob = jobs.find(job => job.groupId === group.id && blocksGroup(job));
  const blocked = !!blockingJob;
  const mutation = useAsyncMutation(); const readOnly = current?.submissionState === "submitted" || current?.submissionState === "unknown"; const busy = mutation.pending || uploading || mutation.readOnly; const submitDisabled = busy || !mutation.ready || blocked;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitDisabled || readOnly) return; setLocalError(null); setSaved("");
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const submit = submitter?.value !== "draft";
    if (kind === "meetup" && submit && !files.some(file => file.mimeType.startsWith("image/"))) { setLocalError(new Error("Upload at least one group photo before submitting the meet-up report.")); return; }
    const edit = { groupId: group.id, ...(current ? { reportId: current.id, expectedVersion: version } : {}), submit };
    let response: AsyncSubmission<"reports.week1.save" | "reports.meetup.save" | "reports.completion.save"> | null = null;
    if (kind === "week1") response = await mutation.run("reports.week1.save", { ...edit, question, flagComment: flag });
    if (kind === "meetup") response = await mutation.run("reports.meetup.save", { ...edit, title, otherGroup, meetupDate: date, attendance: Number(attendance), description, isUseGC: giftCard, isRequiredSC: special, scComment: specialComment, attachmentIds: files.map(file => file.id) });
    if (kind === "completion") response = await mutation.run("reports.completion.save", { ...edit, keyTakeaways: takeaways, mostHelpful: helpful, isJointAgain: again, flagComment: flag });
    if (response?.accepted && isReportJob(response.job)) { onAccepted(response.job); return; }
    if (response && !response.accepted) {
      const result = response.data;
      setCurrent(result.report); setVersion(result.report.version); setFiles(result.report.attachments);
      setSaved(submit ? "Your report has been submitted. It is awaiting review." : "Your draft is saved. You can return to it from Reports.");
      onSaved();
      if (submit && result.report.kind === "meetup" && result.report.submissionState === "submitted" && result.report.isUseGC) onExpense(result.report, true);
    }
  }
  if (readOnly) return <div className="form-stack">{saved ? <SuccessNotice>{saved}</SuccessNotice> : <StatusMark complete={current.submissionState === "submitted"}>{current.submissionState === "unknown" ? "Submission not confirmed" : "Submitted"} · {humanize(current.reviewStatus)}</StatusMark>}<ReportDetails report={current} /><Attachments context={{ parentKind: "meetupReport", parentId: current.id, groupId: group.id }} files={files} readOnly />{current.kind === "meetup" && current.submissionState === "submitted" && current.isUseGC ? <div className="form-actions"><Button onClick={() => onExpense(current)}>Open expense report</Button></div> : null}</div>;
  return <form className="form-stack" onSubmit={submit}>{saved ? <SuccessNotice>{saved}</SuccessNotice> : null}{restored ? <p className="form-hint">Your saved inputs are restored against the latest available record. Review them before submitting a new update.</p> : null}{blocked ? <p className="form-hint" role="status">You can prepare this report while another update awaits sync or review. Submission remains unavailable until that update is resolved.{blockingJob && isReportJob(blockingJob) && jobReportKind(blockingJob) === kind ? <Button type="button" variant="link" onClick={() => onAccepted(blockingJob)}>View saved update</Button> : null}</p> : null}<p className="form-hint">Fields marked * are required.</p><FieldGroup>
    {kind === "week1" ? <><TextField label="How did you support your mentees this week? What question from your mentees impressed you the most?" value={question} onChange={setQuestion} multiline required maxLength={5000} disabled={busy} /><TextField label="Is there anything you would like to flag based on your experience this week?" value={flag} onChange={setFlag} multiline maxLength={5000} disabled={busy} description="Optional" /></> : null}
    {kind === "meetup" ? <><TextField label="What did you do?" value={title} onChange={setTitle} required maxLength={200} disabled={busy} /><TextField label="Other collaborating groups" value={otherGroup} onChange={setOtherGroup} maxLength={200} disabled={busy} description="Optional — list any groups that joined you." /><div className="form-grid"><TextField label="Meet-up date" value={date} onChange={setDate} type="date" required disabled={busy} /><TextField label="Total attendance" value={attendance} onChange={setAttendance} type="number" min="0" max="500" step="1" required disabled={busy} description="Count yourself and your mentees only." /></div><TextField label="How was your meet-up? Where was it located?" value={description} onChange={setDescription} multiline required maxLength={10000} disabled={busy} /><Attachments context={{ parentKind: "meetupReport", groupId: group.id, ...(current ? { parentId: current.id, version } : {}) }} files={files} onChange={setFiles} onVersion={setVersion} onBusy={setUploading} photoOnly disabled={submitDisabled} label="Group photo *" /><p className="form-hint">Upload a photo only when the mentors and mentees pictured have agreed to its internal use by the programme.</p><CheckField label="I spent a gift card at this meet-up" checked={giftCard} onChange={setGiftCard} disabled={busy} />{giftCard ? <p className="form-hint">After you submit, your expense report will open automatically.</p> : null}<CheckField label="I need special consideration" checked={special} onChange={setSpecial} disabled={busy} />{special ? <TextField label="Special consideration comment" value={specialComment} onChange={setSpecialComment} multiline required maxLength={5000} disabled={busy} /> : null}</> : null}
    {kind === "completion" ? <><TextField label="Please share your key takeaways from your experience." value={takeaways} onChange={setTakeaways} multiline required maxLength={10000} disabled={busy} /><TextField label="What helped your mentees the most throughout the programme?" value={helpful} onChange={setHelpful} multiline required maxLength={5000} disabled={busy} description="For example, answering questions or organising meet-ups." /><CheckField label="I would like to be involved in the programme again" checked={again} onChange={setAgain} disabled={busy} /><TextField label="Is there anything you would like to flag based on your experience in this programme?" value={flag} onChange={setFlag} multiline maxLength={5000} disabled={busy} description="Optional" /></> : null}
    <ErrorNotice error={localError || mutation.error} /></FieldGroup><div className="form-actions">{session?.mode === "demo" ? <Button type="submit" name="action" value="draft" variant="outline" disabled={submitDisabled}>Save draft</Button> : null}<Button type="submit" name="action" value="submit" disabled={submitDisabled}>{mutation.pending ? "Saving report…" : "Submit report"}</Button></div></form>;
}
function ReportDetails({ report }: { report: ReportDto }) {
  const fields = report.kind === "week1" ? [["Support and questions", report.question], ["Additional comments", report.flagComment]] : report.kind === "completion" ? [["Key takeaways", report.keyTakeaways], ["What helped most", report.mostHelpful], ["Interested in joining again", report.isJointAgain ? "Yes" : "No"], ["Additional comments", report.flagComment]] : [["Activity", report.title], ["Meet-up date", dateLabel(report.meetupDate)], ["Attendance", String(report.attendance ?? "—")], ["Description and location", report.description], ["Collaborating groups", report.otherGroup], ["Gift card used", report.isUseGC ? "Yes" : "No"], ["Special consideration", report.isRequiredSC ? report.scComment || "Requested" : "Not requested"]];
  return <dl className="record-details">{fields.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function ExpenseSection({ group, report, onSaved }: { group: GroupDto; report?: ReportDto; onSaved: () => void }) {
  const reportId = expenseReportId(report);
  const load = useCallback(() => mentorRequest("groups.get", { groupId: group.id }), [group.id]); const resource = useResource(load, reportId);
  const [submitted, setSubmitted] = useState(false);
  const expenses = reportId ? resource.data?.expenses.filter(expense => expense.meetupReportId === reportId) || [] : [];
  async function saved() { await resource.reload(); setSubmitted(true); onSaved(); }
  return <section className="form-stack" aria-label="Expense details">{submitted ? <SuccessNotice>Your expense report has been submitted.</SuccessNotice> : null}<ErrorNotice error={resource.error} retry={resource.reload} />{expenses.length ? expenses.map(expense => <ExpenseDetails key={expense.id} expense={expense} />) : <><p className="form-hint">{reportId ? "Enter your expense amount and upload the tax invoice for this meet-up." : "You can prepare the amount and tax invoice now. Expense submission will be available after your meet-up report syncs."}</p><ExpenseForm group={group} report={report} blocked={resource.loading || !!resource.error} saved={saved} /></>}</section>;
}
function ExpenseDetails({ expense }: { expense: ExpenseDto }) { return <div className="form-stack"><dl className="record-details"><div><dt>Amount paid</dt><dd>{new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(expense.amount)}</dd></div><div><dt>Receipt status</dt><dd>{humanize(expense.reviewStatus)} · {humanize(expense.processingStatus)}</dd></div></dl><Attachments context={{ parentKind: "expense", parentId: expense.id, groupId: expense.groupId }} files={expense.attachments} readOnly label="Tax invoice" /></div>; }
function ExpenseForm({ group, report, blocked, saved }: { group: GroupDto; report?: ReportDto; blocked: boolean; saved: () => Promise<void> }) {
  const [amount, setAmount] = useState(""); const [files, setFiles] = useState<AttachmentDto[]>([]); const [uploading, setUploading] = useState(false); const [error, setError] = useState<Error | null>(null); const mutation = useMutation();
  const reportId = expenseReportId(report);
  async function submit(event: React.FormEvent) { event.preventDefault(); setError(null); if (!reportId || blocked) { setError(new Error("Wait for the meet-up report to sync and its expenses to load before submitting.")); return; } if (!files.length) { setError(new Error("Upload your tax invoice before submitting the expense.")); return; } const result = await mutation.run("expenses.save", { groupId: group.id, meetupReportId: reportId, amount: Number(amount), attachmentIds: files.map(file => file.id) }); if (result) await saved(); }
  return <form onSubmit={submit}><FieldGroup><TextField label="How much did you pay in your meet-up? (AUD)" value={amount} onChange={setAmount} type="number" min="0.01" max="10000" step="0.01" required disabled={mutation.pending || uploading || mutation.readOnly} /><Attachments context={{ parentKind: "expense", groupId: group.id }} files={files} onChange={setFiles} onBusy={setUploading} disabled={mutation.pending || mutation.readOnly} label="Tax invoice *" /><ErrorNotice error={error || mutation.error} /></FieldGroup><div className="form-actions"><Button disabled={!reportId || blocked || mutation.pending || uploading || mutation.readOnly}>{mutation.pending ? "Submitting expense…" : !reportId ? "Waiting for report sync…" : "Submit expense"}</Button></div></form>;
}
