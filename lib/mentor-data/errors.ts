import type { BridgeResponse, ErrorCode } from '../contracts';

export class MentorError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400, public retryable = false, public requestId?: string) {
    super(message);
    this.name = 'MentorError';
  }
}
export function fail(code: ErrorCode, message: string, status = 400, retryable = false, requestId?: string): never {
  throw new MentorError(code, message, status, retryable, requestId);
}
export function safeError(error: unknown): MentorError {
  return error instanceof MentorError ? error : new MentorError('UPSTREAM_UNAVAILABLE', 'Portal data is temporarily unavailable. Please try again later.', 503, true);
}
export function errorEnvelope(requestId: string, error: unknown): BridgeResponse {
  const e = safeError(error);
  return { schemaVersion: '1.0', requestId: e.requestId ?? requestId, ok: false, error: { code: e.code, message: e.message, retryable: e.retryable } };
}
export function statusForError(code: ErrorCode): number {
  if (['MENTOR_FORBIDDEN', 'OWNERSHIP_DENIED', 'EDIT_NOT_ALLOWED'].includes(code)) return 403;
  if (code === 'RECORD_NOT_FOUND') return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (['BRIDGE_UNAUTHORIZED', 'DRAFT_NOT_CONFIGURED', 'UPSTREAM_UNAVAILABLE', 'CACHE_PENDING', 'CACHE_EXPIRED'].includes(code)) return 503;
  if (['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'REQUEST_IN_PROGRESS', 'PARTIAL_WRITE', 'INSUFFICIENT_CREDIT', 'REWARD_UNAVAILABLE', 'UNSUPPORTED_OPTION_COST'].includes(code)) return 409;
  return 400;
}
