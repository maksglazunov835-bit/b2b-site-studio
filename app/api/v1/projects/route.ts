import { idempotencyKey, parseJsonBody } from '@/server/http/api.mjs';
import { handleOperatorApi } from '@/server/http/operator.mjs';
import { createProject, listProjects } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleOperatorApi(request, () => listProjects());
}

export async function POST(request: Request) {
  return handleOperatorApi(request, async () => {
    const body = await parseJsonBody(request);
    return createProject(body, idempotencyKey(request));
  });
}
