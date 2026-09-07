import { handleOperatorApi } from '@/server/http/operator.mjs';
import { execution } from '@/server/execution/service.mjs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ projectId: string; jobId: string }> };
export async function GET(request: Request, context: Context) {
  return handleOperatorApi(request, async () => {
    const { projectId, jobId } = await context.params;
    return execution.detail(projectId, jobId);
  });
}
