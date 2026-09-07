import { handleApi, idempotencyKey, parseJsonBody } from '@/server/http/api.mjs';
import { bearer } from '@/server/agents/requests.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleApi(async () => agents.register(bearer(request), await parseJsonBody(request), idempotencyKey(request)));
}
