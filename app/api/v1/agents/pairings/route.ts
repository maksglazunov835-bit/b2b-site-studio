import { handleOperatorApi } from '@/server/http/operator.mjs';
import { parseJsonBody } from '@/server/http/api.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleOperatorApi(request, async () => agents.pair(await parseJsonBody(request)), 201);
}
