import { handleOperatorApi } from '@/server/http/operator.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ agentId: string }> };
export async function GET(request: Request, context: Context) {
  return handleOperatorApi(request, async () => agents.get((await context.params).agentId));
}
