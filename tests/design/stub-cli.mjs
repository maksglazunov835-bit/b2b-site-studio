// Explicit CI-only child process, never an official Codex provider.
import assert from 'node:assert/strict';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { proposal } from './fixtures.mjs';
import {
  execArguments,
  clientEnvironment,
} from '../../agent/codex/adapter.mjs';
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf('--output-schema') + 1];
assert.deepEqual(args, execArguments(process.cwd(), schemaPath));
assert.equal(await realpath(process.cwd()), process.cwd());
assert.deepEqual(await readdir(process.cwd()), ['proposal.schema.json']);
assert.equal(
  JSON.parse(await readFile(schemaPath)).title,
  'DesignProposal 1.0.0',
);
for (const key of Object.keys(process.env))
  if (/TOKEN|SECRET|DATABASE|API_KEY|CODEX_HOME|NODE_OPTIONS|^PG/i.test(key))
    throw new Error('Unsafe child environment');
assert.ok(Object.keys(clientEnvironment()).length < 12);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 12000) throw new Error('Input too large');
}
const brief = JSON.parse(input.split('\nBRIEF_JSON\n')[1]);
// Fault selection is test process argv input only, never copied from the brief into a command.
if (['fixture-timeout', 'fixture-stop-unconfirmed'].includes(brief.niche))
  await new Promise((resolve) => setTimeout(resolve, 20000));
if (brief.niche === 'fixture-quota') {
  process.stderr.write('quota exceeded');
  process.exitCode = 1;
} else if (brief.niche === 'fixture-malformed') console.log('not json');
else if (brief.niche === 'fixture-oversized') console.log('x'.repeat(200000));
else if (brief.niche === 'fixture-tool')
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'not executed' },
    }),
  );
else {
  console.log(
    JSON.stringify({ type: 'thread.started', thread_id: 'test-only' }),
  );
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(proposal(brief)) },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, output_tokens: 300 },
    }),
  );
}
