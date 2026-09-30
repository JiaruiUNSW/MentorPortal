import { z } from 'zod';
import type { ClientRequest, Operation } from '../contracts';
import type { Principal } from '../runtime';
import { fail } from './errors';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const version = z.string().min(1).max(100).regex(/^(?:[1-9]\d{0,9}|(?:W\/)?"[A-Za-z0-9{}.,_-]{1,90}")$/);
const text = (max: number) => z.string().trim().max(max).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const required = (max: number) => text(max).refine(v => v.length > 0);
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && v <= '2200-12-31';
});
const list = { cursor: z.string().max(100).optional(), limit: z.number().int().min(1).max(50).optional() };
const reportKind = z.enum(['week1', 'meetup', 'completion']);
const attachmentIds = z.array(id).max(MAX_ATTACHMENTS).refine(v => new Set(v).size === v.length);
const edit = { groupId: id, reportId: id.optional(), expectedVersion: version.optional(), submit: z.boolean().optional() };
const parent = { parentKind: z.enum(['meetupReport', 'expense', 'ticket']), parentId: id.optional(), groupId: id.optional() };
const upload = z.object({ fileName: required(150).refine(v => !/[\/\\<>:"|?*\u007f]/.test(v) && !v.startsWith('.')), mimeType: z.enum(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf']), contentBase64: z.string().min(4).max(Math.ceil(MAX_FILE_BYTES / 3) * 4) }).strict();
export const payloadSchemas = {
  bootstrap: z.object({}).strict(),
  'groups.list': z.object({ ...list, period: z.enum(['all', 'current', 'past', 'future']).optional() }).strict(),
  'groups.get': z.object({ groupId: id }).strict(),
  'reports.list': z.object({ ...list, groupId: id.optional(), kind: reportKind.optional() }).strict(),
  'reports.get': z.object({ kind: reportKind, reportId: id }).strict(),
  'balance.get': z.object({}).strict(),
  'transactions.list': z.object(list).strict(),
  'rewards.list': z.object(list).strict(),
  'rewards.get': z.object({ rewardId: id }).strict(),
  'profile.get': z.object({}).strict(),
  'tickets.list': z.object({ ...list, search: text(100).optional() }).strict(),
  'tickets.get': z.object({ ticketId: id }).strict(),
  'redemptions.list': z.object(list).strict(),
  'attendance.save': z.object({ groupId: id, expectedVersion: version, entries: z.array(z.object({ menteeId: id, attended: z.boolean(), expectedVersion: version }).strict()).min(1).max(100).refine(v => new Set(v.map(e => e.menteeId)).size === v.length) }).strict(),
  'reports.week1.save': z.object({ ...edit, question: required(5000), flagComment: text(5000).optional() }).strict(),
  'reports.meetup.save': z.object({ ...edit, title: required(200), otherGroup: text(200).optional(), meetupDate: dateOnly, attendance: z.number().int().min(0).max(500), description: required(10000), isUseGC: z.boolean(), isRequiredSC: z.boolean(), scComment: text(5000).optional(), attachmentIds: attachmentIds.optional() }).strict().refine(p => !p.isRequiredSC || !!p.scComment?.trim()),
  'reports.completion.save': z.object({ ...edit, keyTakeaways: required(10000), mostHelpful: required(5000), isJointAgain: z.boolean(), flagComment: text(5000).optional() }).strict(),
  'expenses.save': z.object({ groupId: id, meetupReportId: id, expenseId: id.optional(), expectedVersion: version.optional(), amount: z.number().finite().positive().max(10000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001), attachmentIds: attachmentIds.refine(v => v.length > 0) }).strict(),
  'attachments.upload': z.object({ ...parent, expectedVersion: version.optional(), file: upload }).strict().refine(p => p.parentKind === 'ticket' || !!p.groupId || !!p.parentId),
  'attachments.download': z.object({ ...parent, attachmentId: id }).strict(),
  'attachments.delete': z.object({ ...parent, expectedVersion: version.optional(), attachmentId: id }).strict(),
  'profile.update': z.object({ expectedVersion: version, country: required(100), phoneNumber: required(40).refine(v => /^[+\d ()-]{5,40}$/.test(v)), communicationChannels: z.array(required(50)).max(10), programs: z.array(required(100)).max(10), stream: text(100), otherStream: text(200), under18: z.boolean(), wwcc: text(50).optional(), wwccExpiryDate: dateOnly.optional(), dateOfBirth: dateOnly.optional() }).strict().refine(p => p.under18 ? !!p.dateOfBirth : !!p.wwcc && !!p.wwccExpiryDate),
  'redemptions.create': z.object({ rewardId: id, optionIds: z.array(id).max(5).refine(v => new Set(v).size === v.length), comment: text(1000) }).strict(),
  'tickets.create': z.object({ title: required(200), description: required(10000), attachmentIds: attachmentIds.optional() }).strict(),
  'tickets.update': z.object({ ticketId: id, expectedVersion: version, title: required(200), description: required(10000) }).strict(),
} satisfies Record<Operation, z.ZodTypeAny>;

export function isWrite(operation: Operation): boolean {
  return !['bootstrap', 'groups.list', 'groups.get', 'reports.list', 'reports.get', 'balance.get', 'transactions.list', 'rewards.list', 'rewards.get', 'profile.get', 'tickets.list', 'tickets.get', 'redemptions.list', 'attachments.download'].includes(operation);
}
export function parseClientRequest(input: unknown): ClientRequest {
  const top = z.object({ operation: z.string(), payload: z.unknown(), idempotencyKey: z.string().uuid().optional() }).strict().safeParse(input);
  if (!top.success || !Object.hasOwn(payloadSchemas, top.data.operation)) fail('VALIDATION_ERROR', 'The request is not a supported portal operation.');
  const operation = top.data.operation as Operation;
  const parsed = payloadSchemas[operation].safeParse(top.data.payload ?? {});
  if (!parsed.success) fail('VALIDATION_ERROR', 'Please check the required fields, values and attachments.');
  if (isWrite(operation) && !top.data.idempotencyKey) fail('VALIDATION_ERROR', 'This change requires an idempotency key.');
  return { operation, payload: parsed.data, ...(top.data.idempotencyKey ? { idempotencyKey: top.data.idempotencyKey } : {}) } as ClientRequest;
}
export function requireMentor(principal: Principal, mode: 'demo' | 'live'): void {
  if (principal.role !== 'mentor' || !Number.isSafeInteger(principal.mentorUserId) || principal.mentorUserId <= 0 || principal.mode !== mode) fail('MENTOR_FORBIDDEN', 'A valid mentor account for this portal mode is required.', 403);
}
export function expectVersion(current: string, expected?: string): void {
  if (!expected || expected !== current) fail('VERSION_CONFLICT', 'This record changed. Reload it before saving.', 409);
}
export function parseForwardedUpload(file: unknown): Uint8Array {
  const parsed = upload.safeParse(file);
  if (!parsed.success) fail('ATTACHMENT_REJECTED', 'The forwarded attachment fields are invalid.');
  return parseUpload(parsed.data);
}
export function parseUpload(file: z.infer<typeof upload>, maxFileNameLength = 150): Uint8Array {
  if (!file.fileName || file.fileName.length > maxFileNameLength || /[\/\\<>:"|?*\u0000-\u001f\u007f]/.test(file.fileName) || file.fileName.startsWith('.')) fail('ATTACHMENT_REJECTED', 'The attachment filename is invalid.');
  const allowed = file.mimeType === 'image/jpeg' ? /\.jpe?g$/i : file.mimeType === 'image/png' ? /\.png$/i : file.mimeType === 'image/heic' ? /\.heic$/i : file.mimeType === 'image/heif' ? /\.heif$/i : /\.pdf$/i;
  if (!allowed.test(file.fileName) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) fail('ATTACHMENT_REJECTED', 'The attachment type or encoding is not supported.');
  let raw: string;
  try { raw = atob(file.contentBase64); } catch { fail('ATTACHMENT_REJECTED', 'The attachment encoding is invalid.'); }
  if (!raw.length || raw.length > MAX_FILE_BYTES || btoa(raw) !== file.contentBase64) fail('ATTACHMENT_REJECTED', 'Each attachment must be no larger than 5 MiB.');
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const isoSize = bytes.length >= 16 ? new DataView(bytes.buffer).getUint32(0) : 0;
  const majorBrand = raw.slice(8, 12);
  const validHeif = isoSize >= 16 && isoSize <= bytes.length && isoSize <= 4096 && isoSize % 4 === 0 && raw.slice(4, 8) === 'ftyp' && (file.mimeType === 'image/heic' ? ['heic', 'heix', 'hevc', 'hevx'].includes(majorBrand) : ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx'].includes(majorBrand));
  const matches = file.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : file.mimeType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) : file.mimeType === 'application/pdf' ? [37, 80, 68, 70, 45].every((v, i) => bytes[i] === v) : validHeif;
  if (!matches) fail('ATTACHMENT_REJECTED', 'The attachment content does not match its declared type.');
  return bytes;
}
