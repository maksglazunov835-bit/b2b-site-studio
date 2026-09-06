import { handleOperatorApi } from '@/server/http/operator.mjs';
import { parseJsonBody } from '@/server/http/api.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ agentId: string }> };
export async function POST(request: Request, context: Context) {
  return handleOperatorApi(request, async () => agents.revoke((await context.params).agentId, await parseJsonBody(request)));
}
