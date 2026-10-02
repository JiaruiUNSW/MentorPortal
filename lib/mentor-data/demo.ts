import type { AttachmentDto, BalanceDto, ClientRequest, ExpenseDto, GroupDto, Id, MenteeDto, OperationPayloads, ProfileChoices, ProfileDto, RedemptionDto, ReportDto, RewardDto, RewardOptionDto, TaskDto, TicketDto, TransactionDto } from '../contracts';
import type { Principal } from '../runtime';
import { fail } from './errors';
import { expectVersion, MAX_ATTACHMENTS } from './validation';
import { CREDIT_CRITERIA } from './credit-criteria';

export interface DemoState {
  schemaVersion: 1;
  groups: GroupDto[];
  mentees: (MenteeDto & { groupId: Id })[];
  reports: ReportDto[];
  expenses: ExpenseDto[];
  balance: BalanceDto;
  transactions: TransactionDto[];
  rewards: RewardDto[];
  options: RewardOptionDto[];
  profile: ProfileDto;
  choices: ProfileChoices;
  tickets: TicketDto[];
  redemptions: RedemptionDto[];
}
export const PREVIEW_LABEL = 'Synthetic preview data — not connected to SharePoint';
const newId = () => `demo_${crypto.randomUUID()}`;
const nextVersion = (version: string) => String(Number(version) + 1);
const businessDate = (now: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const photo = (a: AttachmentDto) => ['image/jpeg', 'image/png', 'image/heic', 'image/heif'].includes(a.mimeType);
export function createDemoState(principal: Principal): DemoState {
  const now = '2026-09-30T02:00:00.000Z';
  const groups: GroupDto[] = [ ['Group Cedar', 'Diploma', 4], ['Group Banksia', 'Foundation', 3], ['Group Wattle', 'Diploma', 5] ].map(([title, type, count]) => ({
    id: newId(), version: '1', title: String(title), roundId: 'Round 3 2026', startDate: '2026-09-14', type: String(type), mode: 'In person', groupStatus: 1, reportEnabled: true, mplName: 'Preview Coordinator', mplCommunicationEmail: 'coordinator@example.invalid', menteeCount: Number(count), attendedCount: title === 'Group Cedar' ? 2 : 0, week1Reports: title === 'Group Cedar' ? 1 : 0, meetupReports: 0, completionReports: 0, firstAttendanceUpdatedAt: title === 'Group Cedar' ? now : null, attendanceUpdatedAt: title === 'Group Cedar' ? now : null, week1ReportedAt: title === 'Group Cedar' ? now : null, firstMeetupReportedAt: null, secondMeetupReportedAt: null, completedAt: null,
  }));
  const names = [ ['Jamie Lee', 'Sam Rivera', 'Taylor Chen', 'Casey Green'], ['Alex Morgan', 'Drew Lane', 'Riley Park'], ['Jordan Quinn', 'Avery Reed', 'Robin West', 'Skyler Bell', 'Morgan Dale'] ];
  const mentees = groups.flatMap((g, gi) => names[gi].map((name, i) => ({ id: newId(), version: '1', groupId: g.id, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '), gender: 'Not specified', nationality: 'Preview', under18: 'No', visa: 'Preview', program: g.type, attended: gi === 0 && i < 2, attendanceRecorded: gi === 0 && i < 2 })));
  const reports: ReportDto[] = [
    { id: newId(), version: '1', kind: 'week1', groupId: groups[0].id, title: 'Week 1 check-in', createdAt: now, modifiedAt: now, reviewStatus: 'submitted', submissionState: 'submitted', question: 'We introduced ourselves and discussed settling into the new round.', flagComment: '', attachments: [] },
    { id: newId(), version: '1', kind: 'meetup', groupId: groups[0].id, title: 'Campus catch-up', createdAt: now, modifiedAt: now, reviewStatus: 'submitted', submissionState: 'draft', otherGroup: '', meetupDate: '2026-09-30', attendance: 2, description: 'Draft: planning a campus catch-up and sharing study tips.', isUseGC: false, isRequiredSC: false, scComment: '', attachments: [] },
  ];
  const rewards: RewardDto[] = [ ['Campus coffee voucher', 40, 'Voucher'], ['Mentor notebook', 60, 'Merchandise'], ['College hoodie', 120, 'Merchandise'] ].map(([name, points, productType]) => ({ id: newId(), name: String(name), inStock: true, points: Number(points), discountPoints: null, effectivePoints: Number(points), productType: String(productType), imageUrl: null }));
  const options: RewardOptionDto[] = [{ id: newId(), rewardId: rewards[2].id, label: 'Navy', type: 'Color', inStock: true, extraCost: 0 }, ...['S','M','L'].map(label => ({ id: newId(), rewardId: rewards[2].id, label, type: 'Size' as const, inStock: true, extraCost: 0 }))];
  return { schemaVersion: 1, groups, mentees, reports, expenses: [], balance: { balance: 180, reserved: 0, totalCredit: 240, roundCount: 3, milestone: 300, milestoneRound: 5 }, transactions: [
    { id: newId(), transactionId: 'PREVIEW-CREDIT-003', type: 'Credit', group: 'Group Cedar', amount: 120, timestamp: now, notes: 'Synthetic mentor participation credit', issuer: 'Preview programme' },
    { id: newId(), transactionId: 'PREVIEW-CREDIT-002', type: 'Credit', group: 'Previous preview round', amount: 120, timestamp: '2026-08-20T02:00:00.000Z', notes: 'Synthetic previous round credit', issuer: 'Preview programme' },
    { id: newId(), transactionId: 'PREVIEW-REWARD-001', type: 'Redemption', group: '', amount: -60, timestamp: '2026-08-21T02:00:00.000Z', notes: 'Synthetic historical notebook redemption', issuer: 'Preview programme' },
  ], rewards, options, profile: { id: `demo_mentor_${principal.accountId}`, version: '1', displayName: principal.displayName, preferredName: principal.displayName, communicationEmail: principal.email, country: 'Australia', phoneNumber: '+61 400 000 000', communicationChannels: ['WhatsApp'], programs: ['Diploma'], stream: 'Science', otherStream: '', wwcc: 'PREVIEW-WWCC', wwccExpiryDate: '2028-12-31', dateOfBirth: null }, choices: { communicationChannels: ['WhatsApp', 'WeChat', 'Email'], programs: ['Diploma', 'Foundation'], streams: ['Business', 'Engineering', 'Science', 'Others'] }, tickets: [], redemptions: [] };
}
function owned<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find(i => i.id === id);
  if (!item) fail('RECORD_NOT_FOUND', 'This record is unavailable or does not belong to your account.', 404);
  return item;
}
export function ownedGroup(state: DemoState, groupId: string): GroupDto { return owned(state.groups, groupId); }
function groupSummary(state: DemoState, group: GroupDto): GroupDto {
  // Derive this on read so existing persisted preview records need no migration or reseeding.
  return { ...group, meetupCount: state.reports.filter(report => report.groupId === group.id && report.kind === 'meetup').length };
}
function reportWritable(state: DemoState, groupId: string): GroupDto {
  const group = ownedGroup(state, groupId);
  if (!group.reportEnabled) fail('EDIT_NOT_ALLOWED', 'Reports and attendance are closed for this group.', 403);
  return group;
}
export function groupTasks(state: DemoState, group: GroupDto): TaskDto[] {
  const reports = state.reports.filter(r => r.groupId === group.id);
  const rTask = (kind: ReportDto['kind'], key: TaskDto['key'], label: string, occurrence = 0): TaskDto => {
    const records = reports.filter(r => r.kind === kind).slice(occurrence, occurrence + 1);
    const submitted = records.some(r => r.submissionState === 'submitted');
    const draft = records.some(r => r.submissionState === 'draft');
    return { key, label, deadline: null, status: submitted ? 'Completed' : group.reportEnabled ? 'Ongoing' : 'Unavailable', submissionState: submitted ? 'submitted' : draft ? 'draft' : 'not_started' };
  };
  return [ { key: 'attendance.first', label: 'First attendance', deadline: null, status: group.firstAttendanceUpdatedAt ? 'Completed' : 'Ongoing', submissionState: group.firstAttendanceUpdatedAt ? 'submitted' : 'not_started' }, rTask('week1', 'report.week1', 'Week 1 report'), rTask('meetup', 'report.meetup1', 'First meet-up report'), rTask('meetup', 'report.meetup2', 'Second meet-up report', 1), { key:'attendance.final',label:'Final attendance',deadline:null,status:group.completedAt?'Completed':'Ongoing',submissionState:group.completedAt?'submitted':'not_started' }, rTask('completion', 'report.completion', 'Completion report') ];
}
function page<T>(items: T[], payload: { cursor?: string; limit?: number }) {
  let offset = 0;
  if (payload.cursor) {
    try { const decoded = atob(payload.cursor); if (!/^offset:\d+$/.test(decoded)) throw new Error(); offset = Number(decoded.slice(7)); } catch { fail('VALIDATION_ERROR', 'The page cursor is invalid.'); }
    if (!Number.isSafeInteger(offset) || offset > 10000) fail('VALIDATION_ERROR', 'The page cursor is invalid.');
  }
  const size = payload.limit ?? 25;
  return { items: items.slice(offset, offset + size), nextCursor: offset + size < items.length ? btoa(`offset:${offset + size}`) : null };
}
export function readDemo(state: DemoState, request: ClientRequest): unknown {
  const p = request.payload;
  switch (request.operation) {
    case 'bootstrap': return { mentor: { id: state.profile.id, displayName: state.profile.displayName, preferredName: state.profile.preferredName, communicationEmail: state.profile.communicationEmail }, balance: state.balance, groups: state.groups.map(group => groupSummary(state, group)), tasks: state.groups.flatMap(g => groupTasks(state, g).map(t => ({ ...t, groupId: g.id }))), mode: 'demo', previewLabel: PREVIEW_LABEL };
    case 'groups.list': { const v = p as OperationPayloads['groups.list']; return page(state.groups.filter(g => !v.period || v.period === 'all' || (v.period === 'current' ? g.groupStatus === 1 : v.period === 'past' ? g.groupStatus === 2 : g.groupStatus === 0)).map(group => groupSummary(state, group)), v); }
    case 'groups.get': { const group = ownedGroup(state, (p as OperationPayloads['groups.get']).groupId); return { group: groupSummary(state, group), mentees: state.mentees.filter(m => m.groupId === group.id), reports: state.reports.filter(r => r.groupId === group.id), expenses: state.expenses.filter(e => e.groupId === group.id), tasks: groupTasks(state, group) }; }
    case 'reports.list': { const v = p as OperationPayloads['reports.list']; if (v.groupId) ownedGroup(state, v.groupId); return page(state.reports.filter(r => (!v.groupId || r.groupId === v.groupId) && (!v.kind || r.kind === v.kind)), v); }
    case 'reports.get': { const v = p as OperationPayloads['reports.get']; const report = owned(state.reports, v.reportId); if (report.kind !== v.kind) fail('RECORD_NOT_FOUND', 'The report is unavailable.', 404); ownedGroup(state, report.groupId); return { report }; }
    case 'balance.get': return { ...state.balance, ranking: [{ rank: 1, mentorName: 'Preview Mentor Rowan', roundCount: 5, groupCount: 8, currentCredit: 280, isCurrentMentor: false }, { rank: 2, mentorName: 'Preview Mentor Sage', roundCount: 4, groupCount: 6, currentCredit: 210, isCurrentMentor: false }, { rank: 3, mentorName: state.profile.displayName, roundCount: state.balance.roundCount, groupCount: state.groups.length, currentCredit: state.balance.balance, isCurrentMentor: true }], creditCriteria: CREDIT_CRITERIA };
    case 'transactions.list': return page(state.transactions, p as OperationPayloads['transactions.list']);
    case 'rewards.list': return page(state.rewards, p as OperationPayloads['rewards.list']);
    case 'rewards.get': { const reward = owned(state.rewards, (p as OperationPayloads['rewards.get']).rewardId); return { reward, options: state.options.filter(o => o.rewardId === reward.id) }; }
    case 'profile.get': return { profile: state.profile, choices: state.choices };
    case 'tickets.list': { const v = p as OperationPayloads['tickets.list']; return page(state.tickets.filter(t => !v.search || `${t.title} ${t.description}`.toLowerCase().includes(v.search.toLowerCase())), v); }
    case 'tickets.get': return { ticket: owned(state.tickets, (p as OperationPayloads['tickets.get']).ticketId) };
    case 'redemptions.list': return page(state.redemptions, p as OperationPayloads['redemptions.list']);
    default: fail('VALIDATION_ERROR', 'This read operation is not supported.');
  }
}
export interface FileBinding { id: string; parentId: string; groupId?: string }
export interface WriteContext { now: string; requestId: string; files: AttachmentDto[]; upload?: AttachmentDto }
export interface DemoChange { state: DemoState; data: unknown; bindings: FileBinding[]; deletedFileId?: string }

export function validateFileParent(state: DemoState, file: Pick<AttachmentDto, 'parentKind' | 'parentId' | 'groupId'>, expectedVersion?: string, editing = false): { parent?: ReportDto | ExpenseDto | TicketDto; group?: GroupDto } {
  if (!file.parentId) {
    if (file.parentKind !== 'ticket') {
      if (!file.groupId) fail('OWNERSHIP_DENIED', 'An owned group is required for this attachment.', 403);
      return { group: editing ? reportWritable(state, file.groupId) : ownedGroup(state, file.groupId) };
    }
    if (file.groupId) fail('VALIDATION_ERROR', 'Ticket attachments cannot be linked to a group.');
    return {};
  }
  let parent: ReportDto | ExpenseDto | TicketDto;
  if (file.parentKind === 'ticket') {
    parent = owned(state.tickets, file.parentId);
    if (file.groupId) fail('VALIDATION_ERROR', 'Ticket attachments cannot be linked to a group.');
    if (editing && parent.status === 'Closed') fail('EDIT_NOT_ALLOWED', 'Closed tickets cannot be edited.', 403);
  } else {
    parent = file.parentKind === 'meetupReport' ? owned(state.reports, file.parentId) : owned(state.expenses, file.parentId);
    if (file.parentKind === 'meetupReport' && (parent as ReportDto).kind !== 'meetup') fail('OWNERSHIP_DENIED', 'This attachment target is unavailable.', 403);
    const gid = (parent as ReportDto | ExpenseDto).groupId;
    if (file.groupId && gid !== file.groupId) fail('OWNERSHIP_DENIED', 'This attachment belongs to a different group.', 403);
    if (editing) reportWritable(state, gid); else ownedGroup(state, gid);
    if (editing && (parent as ReportDto | ExpenseDto).reviewStatus === 'accepted') fail('EDIT_NOT_ALLOWED', 'Accepted records cannot be edited.', 403);
  }
  if (editing) expectVersion(parent.version, expectedVersion);
  return { parent, ...('groupId' in parent ? { group: ownedGroup(state, parent.groupId) } : {}) };
}
export function writeDemo(original: DemoState, request: ClientRequest, context: WriteContext): DemoChange {
  const state = structuredClone(original);
  const bindings: FileBinding[] = [];
  const { now, requestId } = context;
  const p = request.payload;
  const attach = (ids: string[] | undefined, kind: AttachmentDto['parentKind'], parentId: string, groupId?: string, current: AttachmentDto[] = []) => {
    const incoming = (ids ?? []).map(id => {
      const f = owned(context.files, id);
      if (f.parentKind !== kind || f.groupId !== groupId || (f.parentId && f.parentId !== parentId)) fail('OWNERSHIP_DENIED', 'An attachment does not belong to this record.', 403);
      bindings.push({ id, parentId, ...(groupId ? { groupId } : {}) });
      return { ...f, parentId };
    });
    const all = [...current];
    for (const f of incoming) if (!all.some(a => a.id === f.id)) all.push(f);
    if (all.length > MAX_ATTACHMENTS) fail('ATTACHMENT_REJECTED', 'A record can contain at most five attachments.');
    return all;
  };
  let data: unknown;
  switch (request.operation) {
    case 'attendance.save': {
      const v = p as OperationPayloads['attendance.save'];
      const group = reportWritable(state, v.groupId); expectVersion(group.version, v.expectedVersion);
      for (const entry of v.entries) { const mentee = owned(state.mentees, entry.menteeId); if (mentee.groupId !== group.id) fail('OWNERSHIP_DENIED', 'A mentee does not belong to this group.', 403); expectVersion(mentee.version, entry.expectedVersion); mentee.attended = entry.attended; mentee.attendanceRecorded = true; mentee.version = nextVersion(mentee.version); }
      group.attendedCount = state.mentees.filter(m => m.groupId === group.id && m.attended).length; group.firstAttendanceUpdatedAt ??= now; group.attendanceUpdatedAt = now; group.version = nextVersion(group.version);
      data = { group: groupSummary(state, group), mentees: state.mentees.filter(m => m.groupId === group.id) }; break;
    }
    case 'reports.week1.save': case 'reports.meetup.save': case 'reports.completion.save': {
      const v = p as OperationPayloads['reports.meetup.save'] & OperationPayloads['reports.week1.save'] & OperationPayloads['reports.completion.save'];
      const kind = request.operation.split('.')[1] as ReportDto['kind'];
      const group = reportWritable(state, v.groupId);
      let report: ReportDto;
      if (v.reportId) { report = owned(state.reports, v.reportId); if (report.groupId !== group.id || report.kind !== kind) fail('OWNERSHIP_DENIED', 'This report does not belong to the selected group.', 403); expectVersion(report.version, v.expectedVersion); if (report.reviewStatus === 'accepted') fail('EDIT_NOT_ALLOWED', 'Accepted reports cannot be edited.', 403); if (report.submissionState === 'submitted' && v.submit === false) fail('EDIT_NOT_ALLOWED', 'A submitted report cannot be changed back to a draft.', 409); report.version = nextVersion(report.version); }
      else { if (kind !== 'meetup' && state.reports.some(r => r.groupId === group.id && r.kind === kind)) fail('VERSION_CONFLICT', 'This report already exists. Open it to make changes.', 409); report = { id: `demo_${requestId}`, version: '1', kind, groupId: group.id, title: kind === 'week1' ? 'Week 1 report' : 'Completion report', createdAt: now, modifiedAt: now, reviewStatus: 'submitted', submissionState: 'draft', attachments: [] }; state.reports.push(report); }
      if (kind === 'week1') Object.assign(report, { question: v.question, flagComment: v.flagComment ?? '' });
      if (kind === 'meetup') { if (v.submit !== false && v.meetupDate > businessDate(now)) fail('VALIDATION_ERROR', 'A submitted meet-up date cannot be in the future.'); Object.assign(report, { title: v.title, otherGroup: v.otherGroup ?? '', meetupDate: v.meetupDate, attendance: v.attendance, description: v.description, isUseGC: v.isUseGC, isRequiredSC: v.isRequiredSC, scComment: v.scComment ?? '', attachments: attach(v.attachmentIds, 'meetupReport', report.id, group.id, report.attachments) }); if (v.submit !== false && !report.attachments.some(photo)) fail('ATTACHMENT_REJECTED', 'A meet-up photograph is required before final submission.'); }
      if (kind === 'completion') Object.assign(report, { keyTakeaways: v.keyTakeaways, mostHelpful: v.mostHelpful, isJointAgain: v.isJointAgain, flagComment: v.flagComment ?? '' });
      report.modifiedAt = now; report.submissionState = v.submit === false ? 'draft' : 'submitted';
      const submitted = state.reports.filter(r => r.groupId === group.id && r.submissionState === 'submitted');
      group.week1Reports = submitted.filter(r => r.kind === 'week1').length; group.meetupReports = submitted.filter(r => r.kind === 'meetup').length; group.completionReports = submitted.filter(r => r.kind === 'completion').length;
      if (v.submit !== false) { if (kind === 'week1') group.week1ReportedAt ??= now; if (kind === 'completion') group.completedAt ??= now; if (kind === 'meetup') { group.firstMeetupReportedAt ??= now; if (group.meetupReports > 1) group.secondMeetupReportedAt ??= now; } }
      group.version = nextVersion(group.version); data = { report, group: groupSummary(state, group) }; break;
    }
    case 'expenses.save': {
      const v = p as OperationPayloads['expenses.save']; const group = reportWritable(state, v.groupId); const report = owned(state.reports, v.meetupReportId);
      if (report.groupId !== group.id || report.kind !== 'meetup') fail('OWNERSHIP_DENIED', 'The meet-up report does not belong to this group.', 403);
      let expense: ExpenseDto;
      if (v.expenseId) { expense = owned(state.expenses, v.expenseId); if (expense.groupId !== group.id || expense.meetupReportId !== report.id) fail('OWNERSHIP_DENIED', 'This expense belongs to a different report.', 403); expectVersion(expense.version, v.expectedVersion); if (expense.reviewStatus === 'accepted') fail('EDIT_NOT_ALLOWED', 'Accepted expenses cannot be edited.', 403); expense.version = nextVersion(expense.version); }
      else { expense = { id: `demo_${requestId}`, version: '1', groupId: group.id, meetupReportId: report.id, amount: v.amount, currency: 'AUD', reviewStatus: 'submitted', processingStatus: 'not_requested', attachments: [] }; state.expenses.push(expense); }
      expense.amount = v.amount; expense.attachments = attach(v.attachmentIds, 'expense', expense.id, group.id, expense.attachments); if (!expense.attachments.length) fail('ATTACHMENT_REJECTED', 'A receipt is required.'); data = { expense }; break;
    }
    case 'profile.update': {
      const v = p as OperationPayloads['profile.update']; expectVersion(state.profile.version, v.expectedVersion);
      if (v.communicationChannels.some(c => !state.choices.communicationChannels.includes(c)) || v.programs.some(c => !state.choices.programs.includes(c)) || (v.stream && !state.choices.streams.includes(v.stream))) fail('VALIDATION_ERROR', 'Choose a supported programme, communication channel and stream.');
      if (v.stream === 'Others' && !v.otherStream) fail('VALIDATION_ERROR', 'Please enter your other stream.');
      if (v.dateOfBirth) { const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 18); if (v.dateOfBirth > businessDate(now) || (v.under18 && v.dateOfBirth <= cutoff.toISOString().slice(0, 10))) fail('VALIDATION_ERROR', 'Please check the date of birth and under-18 selection.'); }
      if (!v.under18 && v.wwccExpiryDate && v.wwccExpiryDate < businessDate(now)) fail('VALIDATION_ERROR', 'Please provide a current WWCC expiry date.');
      Object.assign(state.profile, { version: nextVersion(state.profile.version), country: v.country, phoneNumber: v.phoneNumber, communicationChannels: [...new Set(v.communicationChannels)], programs: [...new Set(v.programs)], stream: v.stream, otherStream: v.otherStream, ...(v.under18 ? { dateOfBirth: v.dateOfBirth!, wwcc: '', wwccExpiryDate: null } : { wwcc: v.wwcc!, wwccExpiryDate: v.wwccExpiryDate!, dateOfBirth: v.dateOfBirth ?? state.profile.dateOfBirth }) }); data = { profile: state.profile }; break;
    }
    case 'redemptions.create': {
      const v = p as OperationPayloads['redemptions.create']; const reward = owned(state.rewards, v.rewardId);
      if (!Number.isFinite(v.expectedPoints) || v.expectedPoints < 0) fail('VALIDATION_ERROR', 'Review the reward points before submitting.');
      if (v.expectedPoints !== reward.effectivePoints) fail('VERSION_CONFLICT', 'The reward points have changed. Review the updated reward before submitting again.', 409);
      if (!reward.inStock) fail('REWARD_UNAVAILABLE', 'This reward is unavailable.', 409);
      const options = v.optionIds.map(id => owned(state.options, id));
      if (options.some(o => o.rewardId !== reward.id || !o.inStock)) fail('REWARD_UNAVAILABLE', 'A selected option is unavailable.', 409);
      if (options.some(o => o.extraCost !== 0)) fail('UNSUPPORTED_OPTION_COST', 'This option needs a staff review before redemption.', 409);
      for (const type of new Set(state.options.filter(o => o.rewardId === reward.id).map(o => o.type))) if (options.filter(o => o.type === type).length !== 1) fail('VALIDATION_ERROR', `Choose one ${type.toLowerCase()} option.`);
      if (state.balance.balance < reward.effectivePoints) fail('INSUFFICIENT_CREDIT', 'Your available credit is too low for this reward.', 409);
      const redemption: RedemptionDto = { id: `demo_${requestId}`, requestReference: `PREVIEW-${requestId.slice(0,8).toUpperCase()}`, rewardId: reward.id, rewardName: reward.name, optionIds: v.optionIds, comment: v.comment, points: reward.effectivePoints, status: 'pending', creditState: 'reserved', createdAt: now };
      state.redemptions.unshift(redemption); state.balance.balance -= redemption.points; state.balance.reserved += redemption.points; state.transactions.unshift({ id: `demo_tx_${requestId}`, transactionId: redemption.requestReference, type: 'Pending reservation', group: '', amount: -redemption.points, timestamp: now, notes: 'Preview reward request pending approval; credit reserved.', issuer: 'Preview programme' }); data = { redemption }; break;
    }
    case 'tickets.create': {
      const v = p as OperationPayloads['tickets.create']; const ticket: TicketDto = { id: `demo_${requestId}`, version: '1', title: v.title, description: v.description, status: 'Open', staffName: '', staffComment: '', createdAt: now, modifiedAt: now, attachments: attach(v.attachmentIds, 'ticket', `demo_${requestId}`) }; state.tickets.unshift(ticket); data = { ticket }; break;
    }
    case 'tickets.update': {
      const v = p as OperationPayloads['tickets.update']; const ticket = owned(state.tickets, v.ticketId); expectVersion(ticket.version, v.expectedVersion); if (ticket.status === 'Closed') fail('EDIT_NOT_ALLOWED', 'Closed tickets cannot be edited.', 403); Object.assign(ticket, { title: v.title, description: v.description, modifiedAt: now, version: nextVersion(ticket.version) }); data = { ticket }; break;
    }
    case 'attachments.upload': {
      const v = p as OperationPayloads['attachments.upload']; const { parent } = validateFileParent(state, { ...v, parentId: v.parentId ?? null }, v.expectedVersion, true); const attachment = context.upload; if (!attachment) fail('ATTACHMENT_REJECTED', 'The attachment is not ready.');
      if (parent) { if (parent.attachments.length >= MAX_ATTACHMENTS) fail('ATTACHMENT_REJECTED', 'A record can contain at most five attachments.'); parent.attachments.push(attachment); parent.version = nextVersion(parent.version); bindings.push({ id: attachment.id, parentId: parent.id, ...('groupId' in parent ? { groupId: parent.groupId } : {}) }); }
      data = { attachment, parentVersion: parent?.version ?? null }; break;
    }
    case 'attachments.delete': {
      const v = p as OperationPayloads['attachments.delete']; const file = owned(context.files, v.attachmentId); if (file.parentKind !== v.parentKind || (v.parentId ?? null) !== file.parentId || (v.groupId && v.groupId !== file.groupId)) fail('OWNERSHIP_DENIED', 'The attachment does not belong to this record.', 403);
      const { parent } = validateFileParent(state, file, v.expectedVersion, true);
      if (parent) { if (!parent.attachments.some(a => a.id === file.id)) fail('RECORD_NOT_FOUND', 'The attachment is unavailable.', 404); const remaining = parent.attachments.filter(a => a.id !== file.id); if (file.parentKind === 'expense' && remaining.length === 0) fail('EDIT_NOT_ALLOWED', 'An expense must keep at least one receipt.', 409); if (file.parentKind === 'meetupReport' && (parent as ReportDto).submissionState === 'submitted' && !remaining.some(photo)) fail('EDIT_NOT_ALLOWED', 'A submitted meet-up must keep a photograph.', 409); parent.attachments = remaining; parent.version = nextVersion(parent.version); }
      return { state, data: { deleted: true, parentVersion: parent?.version ?? null }, bindings, deletedFileId: file.id };
    }
    default: fail('VALIDATION_ERROR', 'This write operation is not supported.');
  }
  return { state, data, bindings };
}
