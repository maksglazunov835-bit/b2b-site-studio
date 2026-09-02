import { handleApi, parseJsonBody } from '@/server/http/api.mjs';
import { getProject, patchProject } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type ProjectRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: ProjectRouteContext) {
  return handleApi(async () => {
    const { projectId } = await context.params;
    return getProject(projectId);
  });
}

export async function PATCH(request: Request, context: ProjectRouteContext) {
  return handleApi(async () => {
    const { projectId } = await context.params;
    const body = await parseJsonBody(request);
    const result = await patchProject(projectId, body);
    return result;
  });
}
