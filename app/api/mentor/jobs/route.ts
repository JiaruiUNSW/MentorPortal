import { requireSession } from '@/lib/auth';
import { getBindings } from '@/lib/runtime';
import { listAsyncJobs } from '@/lib/mentor-data/async-queue';
import { asyncErrorResponse, asyncHeaders } from '@/lib/mentor-data/async-http';
import { MentorError } from '@/lib/mentor-data/errors';

export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const principal = await requireSession(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['groupId', 'cursor', 'limit'].includes(key)) ||
        [...params.keys()].some(key => params.getAll(key).length !== 1)) {
      throw new MentorError('VALIDATION_ERROR', 'Use one value for each supported job filter.');
    }
    const limit = params.get('limit');
    if (limit !== null && !/^[1-9]\d?$/.test(limit)) throw new MentorError('VALIDATION_ERROR', 'Choose a valid page size.');
    const data = await listAsyncJobs(getBindings(), principal, {
      ...(params.has('groupId') ? { groupId: params.get('groupId')! } : {}),
      ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
      ...(limit !== null ? { limit: Number(limit) } : {}),
    });
    return Response.json({ schemaVersion: '1.0', requestId, ok: true, data }, { headers: asyncHeaders });
  } catch (error) { return asyncErrorResponse(error, requestId); }
}
