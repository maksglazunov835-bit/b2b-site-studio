import { parseJsonBody } from '@/server/http/api.mjs';
import { handleOperatorApi } from '@/server/http/operator.mjs';
import { getProject, patchProject } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type ProjectRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(request: Request, context: ProjectRouteContext) {
  return handleOperatorApi(request, async () => {
    const { projectId } = await context.params;
    return getProject(projectId);
  });
}

export async function PATCH(request: Request, context: ProjectRouteContext) {
  return handleOperatorApi(request, async () => {
    const { projectId } = await context.params;
    const body = await parseJsonBody(request);
    const result = await patchProject(projectId, body);
    return result;
  });
}
