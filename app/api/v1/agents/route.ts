import { handleOperatorApi } from '@/server/http/operator.mjs';
import { agents } from '@/server/agents/service.mjs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleOperatorApi(request, () => agents.list(new URL(request.url).searchParams));
}
