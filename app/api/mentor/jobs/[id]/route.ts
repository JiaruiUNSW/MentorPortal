import { requireSession } from '@/lib/auth';
import { getBindings } from '@/lib/runtime';
import { getAsyncJob } from '@/lib/mentor-data/async-queue';
import { asyncErrorResponse, asyncHeaders } from '@/lib/mentor-data/async-http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const principal = await requireSession(request);
    const { id } = await context.params;
    const job = await getAsyncJob(getBindings(), principal, id);
    return Response.json({ schemaVersion: '1.0', requestId, ok: true, data: { job } }, { headers: asyncHeaders });
  } catch (error) { return asyncErrorResponse(error, requestId); }
}
