// Synthetic official control-protocol fixture. Never forwards requests to a provider.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  if (r.id === undefined) continue;
  if (mode === 'timeout') continue;
  let result;
  if (r.method === 'initialize') result = {};
  else if (r.method === 'account/read')
    result = {
      account: {
        type: mode === 'api' ? 'apiKey' : 'chatgpt',
        email: 'SYNTHETIC_SECRET_NOT_FOR_RECEIPT',
      },
    };
  else if (r.method === 'model/list')
    result = !r.params.cursor
      ? { data: [], nextCursor: 'page-two' }
      : {
          data: [
            {
              model: mode === 'missing' ? 'gpt-5.6-luna' : 'gpt-6-astra',
              hidden: false,
              supportedReasoningEfforts: ['high', 'ultra', 'max'].map(
                (reasoningEffort) => ({ reasoningEffort }),
              ),
              inputModalities: ['text', 'image'],
            },
          ],
          nextCursor: mode === 'cursor-loop' ? 'page-two' : null,
        };
  else throw new Error('Unexpected RPC');
  if (mode === 'oversized') console.log('x'.repeat(262145));
  else console.log(JSON.stringify({ id: r.id, result }));
}
