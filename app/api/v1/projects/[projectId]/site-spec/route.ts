import { handleApi, idempotencyKey, parseJsonBody } from '@/server/http/api.mjs';
import { getCurrentSiteSpec, saveDraft } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

type SiteSpecRouteContext = {
  params: Promise<{ projectId: string }>;
};

export async function GET(_request: Request, context: SiteSpecRouteContext) {
  return handleApi(async () => {
    const { projectId } = await context.params;
    return getCurrentSiteSpec(projectId);
  });
}

export async function PUT(request: Request, context: SiteSpecRouteContext) {
  return handleApi(async () => {
    const { projectId } = await context.params;
    const body = await parseJsonBody(request);
    return saveDraft(projectId, body, idempotencyKey(request));
  });
}
