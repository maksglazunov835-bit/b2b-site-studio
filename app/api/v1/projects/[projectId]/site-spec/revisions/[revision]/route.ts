import { handleApi } from '@/server/http/api.mjs';
import { getSiteSpecRevision } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type RevisionRouteContext = {
  params: Promise<{ projectId: string; revision: string }>;
};

export async function GET(_request: Request, context: RevisionRouteContext) {
  return handleApi(async () => {
    const { projectId, revision } = await context.params;
    return getSiteSpecRevision(projectId, revision);
  });
}
