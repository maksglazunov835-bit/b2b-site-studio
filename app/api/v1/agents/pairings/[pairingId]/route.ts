import { handleOperatorApi } from '@/server/http/operator.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ pairingId: string }> };
export async function GET(request: Request, context: Context) {
  return handleOperatorApi(request, async () => agents.pairing((await context.params).pairingId));
}
