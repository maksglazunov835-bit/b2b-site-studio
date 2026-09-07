import { handleApi, idempotencyKey } from '@/server/http/api.mjs';
import { bearer } from '@/server/agents/requests.mjs';
import { execution } from '@/server/execution/service.mjs';
import { executionBody } from '@/server/execution/http.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ agentId: string }> };
export async function POST(request: Request, context: Context) {
  return handleApi(async () => execution.claim((await context.params).agentId, bearer(request), await executionBody(request, 'claim'), idempotencyKey(request)));
}
