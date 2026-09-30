/**
 * Proposed bridge contract v1.0, derived from Live Canvas app v548.
 * These are normalized portal DTOs, not raw SharePoint records.
 * Every operation is authorized by the backend and again by its Flow adapter.
 * Draft Flow definitions fail closed; no production endpoints have been activated.
 */
export const ADAPTER_OPERATIONS = {
  Mentor_Read: [
    'bootstrap', 'groups.list', 'groups.get', 'reports.list', 'reports.get',
    'balance.get', 'transactions.list', 'rewards.list', 'rewards.get',
    'profile.get', 'tickets.list', 'tickets.get', 'redemptions.list',
  ],
  Mentor_Attendance: ['attendance.save'],
  Mentor_Report: ['reports.week1.save', 'reports.meetup.save', 'reports.completion.save'],
  Mentor_Expense: ['expenses.save'],
  Mentor_Attachment: ['attachments.upload', 'attachments.download', 'attachments.delete'],
  Mentor_Profile: ['profile.update'],
  Mentor_Redeem: ['redemptions.create'],
  Mentor_Ticket: ['tickets.create', 'tickets.update'],
} as const;

export type Adapter = keyof typeof ADAPTER_OPERATIONS;
export type Operation = (typeof ADAPTER_OPERATIONS)[Adapter][number];
export type Id = string; // Opaque portal ID; a live adapter maps the SharePoint integer.
export type ReportKind = 'week1' | 'meetup' | 'completion';
export type ParentKind = 'meetupReport' | 'expense' | 'ticket';
export type RecordVersion = string; // Opaque ETag/version returned by the adapter; never '*'.
export type DateOnly = string; // YYYY-MM-DD; course/business boundaries use Australia/Sydney.
export type Timestamp = string; // ISO 8601 UTC timestamp.
export type Page<T> = { items: T[]; nextCursor: string | null };
export type UploadFile = {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/heic' | 'image/heif' | 'application/pdf';
  contentBase64: string; // Server verifies decoded size, magic bytes and canonical encoding.
};

export interface AttachmentDto {
  id: string; // Opaque handle bound to the parent; never a SharePoint URL or path.
  fileName: string;
  mimeType: UploadFile['mimeType'];
  sizeBytes: number | null; // Source attachment listing may omit size; actual bytes are checked.
  parentKind: ParentKind;
  parentId: Id | null;
  groupId?: Id;
}
export interface MentorDto {
  id: Id;
  displayName: string;
  preferredName: string;
  communicationEmail: string;
}
export interface GroupDto {
  id: Id;
  version: RecordVersion;
  title: string;
  roundId: string;
  startDate: DateOnly | null;
  type: string;
  mode: string;
  groupStatus: number | null;
  reportEnabled: boolean;
  mplName: string;
  mplCommunicationEmail: string;
  menteeCount: number;
  attendedCount: number;
  week1Reports: number;
  /** Legacy submitted-count summary; it does not limit how many meet-ups a group can have. */
  meetupReports: number;
  /** All saved meet-ups, including drafts/unknown states, only when the complete count is known. */
  meetupCount?: number;
  completionReports: number;
  firstAttendanceUpdatedAt: Timestamp | null;
  attendanceUpdatedAt: Timestamp | null;
  week1ReportedAt: Timestamp | null;
  firstMeetupReportedAt: Timestamp | null;
  secondMeetupReportedAt: Timestamp | null;
  completedAt: Timestamp | null;
}
export interface MenteeDto {
  id: Id;
  version: RecordVersion;
  firstName: string;
  lastName: string;
  gender: string;
  nationality: string;
  under18: string; // Source U18 is text, not a boolean.
  visa: string;
  program: string;
  attended: boolean;
  attendanceRecorded: boolean;
}
export interface TaskDto {
  key: 'attendance.first' | 'report.week1' | 'report.meetup1' | 'report.meetup2' | 'attendance.final' | 'report.completion';
  label: string;
  deadline: DateOnly | null;
  status: 'Completed' | 'Ongoing' | 'Late' | 'Fail' | 'Unavailable';
  submissionState?: 'not_started' | 'draft' | 'submitted';
}
export interface ReportDto {
  id: Id;
  version: RecordVersion;
  kind: ReportKind;
  groupId: Id;
  title: string;
  createdAt: Timestamp | null;
  modifiedAt: Timestamp | null;
  reviewStatus: 'submitted' | 'read' | 'accepted';
  submissionState: 'draft' | 'submitted' | 'repair_required' | 'unknown';
  question?: string;
  flagComment?: string;
  otherGroup?: string;
  meetupDate?: DateOnly;
  attendance?: number;
  description?: string;
  isUseGC?: boolean;
  isRequiredSC?: boolean;
  scComment?: string;
  keyTakeaways?: string;
  mostHelpful?: string;
  isJointAgain?: boolean;
  attachments: AttachmentDto[];
}
export interface ExpenseDto {
  id: Id;
  version: RecordVersion;
  groupId: Id;
  meetupReportId: Id;
  amount: number;
  currency: 'AUD';
  reviewStatus: 'submitted' | 'read' | 'accepted';
  processingStatus: 'not_requested' | 'pending' | 'processed' | 'needs_review' | 'unknown';
  attachments: AttachmentDto[];
}
export interface BalanceDto {
  balance: number;
  totalCredit: number;
  roundCount: number;
  milestone: number;
  milestoneRound: number;
  reserved: number;
  ranking?: { rank: number; mentorName: string; roundCount: number; groupCount: number; currentCredit: number; isCurrentMentor: boolean }[];
  creditCriteria?: { category: 'Basic' | 'Bonus' | 'Milestone' | 'Award'; label: string; points: number; cadence: string }[];
}
export interface TransactionDto {
  id: Id;
  transactionId: string;
  type: string;
  group: string;
  amount: number; // Source Amount is text; malformed values fail normalization.
  timestamp: Timestamp | null;
  notes: string;
  issuer: string;
}
export interface RewardDto {
  id: Id;
  name: string;
  inStock: boolean;
  points: number;
  discountPoints: number | null;
  effectivePoints: number;
  productType: string;
  imageUrl: string | null; // Same-origin proxy or configured asset URL; no arbitrary fetch proxy.
}
export interface RewardOptionDto {
  id: Id;
  rewardId: Id;
  label: string;
  type: 'Color' | 'Size';
  inStock: boolean;
  extraCost: number; // Source stores this; current GiftRedeem ignores it. Nonzero is gated.
}
export interface ProfileDto extends MentorDto {
  version: RecordVersion;
  country: string;
  phoneNumber: string;
  communicationChannels: string[];
  programs: string[];
  stream: string;
  otherStream: string;
  wwcc: string;
  wwccExpiryDate: DateOnly | null;
  dateOfBirth: DateOnly | null;
}
export interface ProfileChoices {
  communicationChannels: string[];
  programs: string[];
  streams: string[];
}
export interface TicketDto {
  id: Id;
  version: RecordVersion;
  title: string;
  description: string; // Plain text at the portal boundary; sanitize existing rich text.
  status: string; // Source status is text. Exactly 'Closed' disables edits.
  staffName: string;
  staffComment: string;
  createdAt: Timestamp | null;
  modifiedAt: Timestamp | null;
  attachments: AttachmentDto[];
}
export interface RedemptionDto {
  id: Id;
  requestReference: string;
  rewardId: Id;
  rewardName: string;
  optionIds: Id[];
  comment: string;
  points: number;
  status: 'pending' | 'processing' | 'approved' | 'rejected' | 'needs_review';
  creditState: 'not_debited' | 'reserved' | 'debited' | 'refunded' | 'needs_review';
  createdAt: Timestamp;
}

type ListPayload = { cursor?: string; limit?: number };
/** Omitting reportId creates a new report. Meet-ups may repeat within a group; edits target one ID. */
type ReportEdit = { groupId: Id; reportId?: Id; expectedVersion?: RecordVersion; submit?: boolean };
type AttachmentParent = { parentKind: ParentKind; parentId?: Id; groupId?: Id };
export interface OperationPayloads {
  bootstrap: Record<string, never>;
  'groups.list': ListPayload & { period?: 'all' | 'current' | 'past' | 'future' };
  'groups.get': { groupId: Id };
  'reports.list': ListPayload & { groupId?: Id; kind?: ReportKind };
  'reports.get': { kind: ReportKind; reportId: Id };
  'balance.get': Record<string, never>;
  'transactions.list': ListPayload;
  'rewards.list': ListPayload;
  'rewards.get': { rewardId: Id };
  'profile.get': Record<string, never>;
  'tickets.list': ListPayload & { search?: string };
  'tickets.get': { ticketId: Id };
  'redemptions.list': ListPayload;
  'attendance.save': { groupId: Id; expectedVersion: RecordVersion; entries: { menteeId: Id; attended: boolean; expectedVersion: RecordVersion }[] };
  'reports.week1.save': ReportEdit & { question: string; flagComment?: string };
  'reports.meetup.save': ReportEdit & { title: string; otherGroup?: string; meetupDate: DateOnly; attendance: number; description: string; isUseGC: boolean; isRequiredSC: boolean; scComment?: string; attachmentIds?: string[] };
  'reports.completion.save': ReportEdit & { keyTakeaways: string; mostHelpful: string; isJointAgain: boolean; flagComment?: string };
  'expenses.save': { groupId: Id; meetupReportId: Id; expenseId?: Id; expectedVersion?: RecordVersion; amount: number; attachmentIds: string[] };
  'attachments.upload': AttachmentParent & { expectedVersion?: RecordVersion; file: UploadFile };
  'attachments.download': AttachmentParent & { attachmentId: string };
  'attachments.delete': AttachmentParent & { expectedVersion?: RecordVersion; attachmentId: string };
  'profile.update': { expectedVersion: RecordVersion; country: string; phoneNumber: string; communicationChannels: string[]; programs: string[]; stream: string; otherStream: string; under18: boolean; wwcc?: string; wwccExpiryDate?: DateOnly; dateOfBirth?: DateOnly };
  'redemptions.create': { rewardId: Id; optionIds: Id[]; comment: string };
  'tickets.create': { title: string; description: string; attachmentIds?: string[] };
  'tickets.update': { ticketId: Id; expectedVersion: RecordVersion; title: string; description: string };
}
export interface OperationResults {
  bootstrap: { mentor: MentorDto; balance: BalanceDto; groups: GroupDto[]; tasks: (TaskDto & { groupId: Id })[]; mode: 'demo' | 'live'; previewLabel: string | null };
  'groups.list': Page<GroupDto>;
  'groups.get': { group: GroupDto; mentees: MenteeDto[]; reports: ReportDto[]; expenses: ExpenseDto[]; tasks: TaskDto[] };
  'reports.list': Page<ReportDto>;
  'reports.get': { report: ReportDto };
  'balance.get': BalanceDto;
  'transactions.list': Page<TransactionDto>;
  'rewards.list': Page<RewardDto>;
  'rewards.get': { reward: RewardDto; options: RewardOptionDto[] };
  'profile.get': { profile: ProfileDto; choices: ProfileChoices };
  'tickets.list': Page<TicketDto>;
  'tickets.get': { ticket: TicketDto };
  'redemptions.list': Page<RedemptionDto>;
  'attendance.save': { group: GroupDto; mentees: MenteeDto[] };
  'reports.week1.save': { report: ReportDto; group: GroupDto };
  'reports.meetup.save': { report: ReportDto; group: GroupDto };
  'reports.completion.save': { report: ReportDto; group: GroupDto };
  'expenses.save': { expense: ExpenseDto };
  'attachments.upload': { attachment: AttachmentDto; parentVersion: RecordVersion | null };
  'attachments.download': { attachment: AttachmentDto; downloadUrl: string };
  'attachments.delete': { deleted: true; parentVersion: RecordVersion | null };
  'profile.update': { profile: ProfileDto };
  'redemptions.create': { redemption: RedemptionDto }; // HTTP 202 after durable request save, never an approval.
  'tickets.create': { ticket: TicketDto };
  'tickets.update': { ticket: TicketDto };
}

/** Browser sends this only. Any actor, userId, list, URL, filter or role at top level is rejected. */
export type ClientRequest<O extends Operation = Operation> = {
  operation: O;
  payload: OperationPayloads[O];
  idempotencyKey?: string; // Required for every mutation; UUID.
};
/** Sent by the backend to one fixed configured Flow URL. Never accepted from a browser unchanged. */
export type BridgeRequest<O extends Operation = Operation> = ClientRequest<O> & {
  schemaVersion: '1.0';
  requestId: string;
  actor: { userId: number; portalAccountId: string };
};
export type ErrorCode =
  | 'VALIDATION_ERROR' | 'BRIDGE_UNAUTHORIZED' | 'MENTOR_FORBIDDEN' | 'RECORD_NOT_FOUND'
  | 'OWNERSHIP_DENIED' | 'EDIT_NOT_ALLOWED' | 'VERSION_CONFLICT' | 'IDEMPOTENCY_CONFLICT'
  | 'REQUEST_IN_PROGRESS' | 'RATE_LIMITED' | 'INSUFFICIENT_CREDIT' | 'REWARD_UNAVAILABLE'
  | 'UNSUPPORTED_OPTION_COST' | 'ATTACHMENT_REJECTED' | 'PARTIAL_WRITE' | 'UPSTREAM_UNAVAILABLE'
  | 'DRAFT_NOT_CONFIGURED';
export type BridgeResponse<O extends Operation = Operation> =
  | { schemaVersion: '1.0'; requestId: string; ok: true; data: OperationResults[O]; replayed?: boolean }
  | { schemaVersion: '1.0'; requestId: string; ok: false; error: { code: ErrorCode; message: string; retryable: boolean; recoveryReference?: string } };
