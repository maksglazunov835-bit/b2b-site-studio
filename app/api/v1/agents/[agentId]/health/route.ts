import { handleApi, parseJsonBody } from '@/server/http/api.mjs';
import { bearer } from '@/server/agents/requests.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ agentId: string }> };
export async function POST(request: Request, context: Context) {
  return handleApi(async () => agents.health((await context.params).agentId, bearer(request), await parseJsonBody(request)));
}
