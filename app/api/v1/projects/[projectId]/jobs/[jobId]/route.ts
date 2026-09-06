import { handleOperatorApi } from '@/server/http/operator.mjs';
import { jobs } from '@/server/jobs/service.mjs';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(request: Request, context: Context) {
  return handleOperatorApi(request, async () => {
    const { projectId, jobId } = await context.params;
    return jobs.get(projectId, jobId);
  });
}
