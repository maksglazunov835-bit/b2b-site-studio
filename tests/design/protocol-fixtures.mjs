import { proposal, brief } from './fixtures.mjs';
// Pinned source: openai/codex rust-v0.153.4 exec/src/exec_events.rs Usage.
export const officialUsage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 10,
  output_tokens: 300,
  reasoning_output_tokens: 150,
};
export const successEvents = (input = brief) => [
  { type: 'thread.started', thread_id: 'synthetic-01534' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'reason',
      type: 'reasoning',
      text: 'SYNTHETIC_SECRET_REASONING_NEVER_STORE',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'answer',
      type: 'agent_message',
      text: JSON.stringify(proposal(input)),
    },
  },
  { type: 'turn.completed', usage: { ...officialUsage } },
];
export const fixtureScenarios = [
  'success',
  'malformed',
  'oversized',
  'tool',
  'timeout',
  'stop-unconfirmed',
  'quota',
  'auth',
  'config',
  'schema',
  'exit2',
  'provider-error',
  'turn-failed',
  'notice-pre-line',
  'notice-pre-coalesced',
  'notice-pre-split',
  'notice-pre-bytewise',
  'notice-pre-crlf',
  'notice-turn',
  'notice-reroute',
  'notice-auth',
  'notice-quota',
  'notice-lost',
  'notice-unknown',
  'unknown-event',
  'forbidden-action',
  'invalid-utf8',
  'truncated',
];
