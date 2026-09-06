import { handleApi, idempotencyKey, parseJsonBody } from '@/server/http/api.mjs';
import { createProject, listProjects } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handleApi(() => listProjects());
}

export async function POST(request: Request) {
  return handleApi(async () => {
    const body = await parseJsonBody(request);
    return createProject(body, idempotencyKey(request));
  });
}
