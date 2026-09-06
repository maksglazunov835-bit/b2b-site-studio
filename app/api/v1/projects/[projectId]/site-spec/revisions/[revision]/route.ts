import { handleOperatorApi } from '@/server/http/operator.mjs';
import { getSiteSpecRevision } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type RevisionRouteContext = {
  params: Promise<{ projectId: string; revision: string }>;
};

export async function GET(request: Request, context: RevisionRouteContext) {
  return handleOperatorApi(request, async () => {
    const { projectId, revision } = await context.params;
    return getSiteSpecRevision(projectId, revision);
  });
}
