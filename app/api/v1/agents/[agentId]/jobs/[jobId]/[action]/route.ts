import { handleApi, idempotencyKey } from '@/server/http/api.mjs';
import { bearer } from '@/server/agents/requests.mjs';
import { execution } from '@/server/execution/service.mjs';
import { executionBody } from '@/server/execution/http.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ agentId: string; jobId: string; action: string }> };
export async function POST(request: Request, context: Context) {
  return handleApi(async () => {
    const { agentId, jobId, action } = await context.params;
    return execution.action(agentId, jobId, bearer(request), action, await executionBody(request, action), idempotencyKey(request));
  });
}
