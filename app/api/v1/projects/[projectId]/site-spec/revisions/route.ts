import { handleOperatorApi } from '@/server/http/operator.mjs';
import { listSiteSpecRevisions } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type RevisionsRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(request: Request, context: RevisionsRouteContext) {
  return handleOperatorApi(request, async () => {
    const { projectId } = await context.params;
    return listSiteSpecRevisions(projectId);
  });
}
