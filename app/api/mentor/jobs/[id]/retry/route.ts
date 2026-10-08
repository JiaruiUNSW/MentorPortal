import { requireMutationProtection, requireSession } from '@/lib/auth';
import { getBindings } from '@/lib/runtime';
import { retryAsyncJob } from '@/lib/mentor-data/async-queue';
import { acceptedResponse, asyncErrorResponse, requireEmptyRetryBody } from '@/lib/mentor-data/async-http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const principal = await requireSession(request);
    await requireMutationProtection(request);
    await requireEmptyRetryBody(request);
    const { id } = await context.params;
    const bindings = getBindings();
    return acceptedResponse(bindings, await retryAsyncJob(bindings, principal, id));
  } catch (error) { return asyncErrorResponse(error, requestId); }
}
