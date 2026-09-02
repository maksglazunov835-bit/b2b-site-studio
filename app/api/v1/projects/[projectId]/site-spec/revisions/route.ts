import { handleApi } from '@/server/http/api.mjs';
import { listSiteSpecRevisions } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type RevisionsRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: RevisionsRouteContext) {
  return handleApi(async () => {
    const { projectId } = await context.params;
    return listSiteSpecRevisions(projectId);
  });
}
