import { handleApi } from '@/server/http/api.mjs';
import { jobs } from '@/server/jobs/service.mjs';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(_request: Request, context: Context) {
  return handleApi(async () => {
    const { projectId, jobId } = await context.params;
    return jobs.get(projectId, jobId);
  });
}
