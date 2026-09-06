import { handleApi } from '@/server/http/api.mjs';
import { databaseHealth } from '@/server/persistence/service.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  return handleApi(() => databaseHealth());
}
