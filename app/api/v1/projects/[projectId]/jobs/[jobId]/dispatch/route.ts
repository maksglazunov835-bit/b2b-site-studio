import { handleOperatorApi } from '@/server/http/operator.mjs';
import { idempotencyKey } from '@/server/http/api.mjs';
import { execution } from '@/server/execution/service.mjs';
import { executionBody } from '@/server/execution/http.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ projectId: string; jobId: string }> };
export async function POST(request: Request, context: Context) {
  return handleOperatorApi(request, async () => {
    const { projectId, jobId } = await context.params;
    return execution.dispatch(projectId, jobId, await executionBody(request, 'dispatch'), idempotencyKey(request));
  });
}
