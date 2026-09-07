import { idempotencyKey, parseJsonBody } from '@/server/http/api.mjs';
import { handleOperatorApi } from '@/server/http/operator.mjs';
import { jobs } from '@/server/jobs/service.mjs';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  return handleOperatorApi(request, async () => jobs.list((await context.params).projectId, new URL(request.url).searchParams));
}

export async function POST(request: Request, context: Context) {
  return handleOperatorApi(request, async () => jobs.create((await context.params).projectId, await parseJsonBody(request), idempotencyKey(request)));
}
