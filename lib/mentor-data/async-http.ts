import { after } from 'next/server';
import { AuthError, authErrorResponse } from '../auth';
import type { PortalBindings } from '../runtime';
import type { AsyncAcceptedResponse } from './async-contract';
import { runAsyncJobs } from './async-worker';
import { errorEnvelope, MentorError, safeError } from './errors';

export const asyncHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export function acceptsAsync(request: Request): boolean {
  return request.headers.get('prefer')?.split(',').some(value => value.split(';')[0].trim().toLowerCase() === 'respond-async') ?? false;
}

/** The durable worker is the fallback if the web process stops after accepting. */
export function acceptedResponse(bindings: PortalBindings, response: AsyncAcceptedResponse): Response {
  try {
    after(async () => {
      try { await runAsyncJobs(bindings, { maxJobs: 1 }); }
      catch { console.error(JSON.stringify({ event: 'mentor_async_wake_failed' })); }
    });
  } catch {
    // A scheduling failure cannot retract a task already committed to storage.
    console.error(JSON.stringify({ event: 'mentor_async_wake_failed' }));
  }
  return Response.json(response, { status: 202, headers: {
    ...asyncHeaders, 'Preference-Applied': 'respond-async', 'Retry-After': '1',
    Location: `/api/mentor/jobs/${encodeURIComponent(response.data.job.id)}`,
  } });
}

export function asyncErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof AuthError) return authErrorResponse(error);
  const safe = safeError(error);
  return Response.json(errorEnvelope(requestId, safe), { status: safe.status, headers: asyncHeaders });
}

export async function requireEmptyRetryBody(request: Request): Promise<void> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new MentorError('VALIDATION_ERROR', 'Use an application/json request body.', 415);
  }
  if (!request.body) throw new MentorError('VALIDATION_ERROR', 'An empty JSON object is required.');
  const reader = request.body.getReader();
  let text = '', size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256) { await reader.cancel(); throw new MentorError('VALIDATION_ERROR', 'The request is too large.', 413); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new MentorError('VALIDATION_ERROR', 'An empty JSON object is required.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
    throw new MentorError('VALIDATION_ERROR', 'Retry the saved request without changing its fields.');
  }
}
