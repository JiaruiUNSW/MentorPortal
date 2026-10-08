import { AuthError, authErrorResponse, requireMutationProtection, requireSession } from '@/lib/auth';
import { getBindings } from '@/lib/runtime';
import { executeMentor } from '@/lib/mentor-data/service';
import { parseClientRequest } from '@/lib/mentor-data/validation';
import { errorEnvelope, MentorError, safeError, statusForError } from '@/lib/mentor-data/errors';
import { enqueueMentorWrite, shouldEnqueueAsync } from '@/lib/mentor-data/async-queue';
import { acceptedResponse, acceptsAsync } from '@/lib/mentor-data/async-http';

export const dynamic = 'force-dynamic';
const MAX_REQUEST_BYTES = 7 * 1024 * 1024 + 16384;
async function readRequest(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new MentorError('VALIDATION_ERROR', 'Use an application/json request body.', 415);
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new MentorError('ATTACHMENT_REJECTED', 'The request is too large.', 413);
  if (!request.body) throw new MentorError('VALIDATION_ERROR', 'The request body is required.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {value,done} = await reader.read(); if(done) break; size+=value.byteLength; if(size>MAX_REQUEST_BYTES) { await reader.cancel(); throw new MentorError('ATTACHMENT_REJECTED', 'The request is too large.', 413); } chunks.push(value); }
  const bytes = new Uint8Array(size); let offset=0; for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MentorError('VALIDATION_ERROR','The request body is not valid JSON.'); }
}
export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const principal = await requireSession(request);
    await requireMutationProtection(request);
    const body = parseClientRequest(await readRequest(request));
    const bindings = getBindings();
    const response = acceptsAsync(request) && shouldEnqueueAsync(bindings, body)
      ? await enqueueMentorWrite(bindings, principal, body, requestId)
      : await executeMentor(bindings, principal, body, requestId);
    if (response.ok && 'accepted' in response && response.accepted) return acceptedResponse(bindings, response);
    return Response.json(response, { status: response.ok ? body.operation === 'redemptions.create' ? 202 : 200 : statusForError(response.error.code), headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    const safe = safeError(error);
    return Response.json(errorEnvelope(requestId, safe), {status:safe.status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
}
