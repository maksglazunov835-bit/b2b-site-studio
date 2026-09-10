// Explicit CI-only child process, never an official Codex provider.
import assert from 'node:assert/strict';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { successEvents, fixtureScenarios } from './protocol-fixtures.mjs';
import wireSchema from '../../docs/contracts/design-proposal.wire.schema.json' with { type: 'json' };
import {
  execArguments,
  clientEnvironment,
} from '../../agent/codex/adapter.mjs';
const scenario = process.argv[2];
assert.ok(fixtureScenarios.includes(scenario));
const args = process.argv.slice(3);
const schemaPath = args[args.indexOf('--output-schema') + 1];
assert.deepEqual(args, execArguments(process.cwd(), schemaPath));
assert.equal(await realpath(process.cwd()), process.cwd());
assert.deepEqual(await readdir(process.cwd()), [
  'output',
  'proposal.schema.json',
]);
assert.deepEqual(JSON.parse(await readFile(schemaPath)), wireSchema);
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
// Fault selection belongs only to this test executable's argv, never the brief.
if (['timeout', 'stop-unconfirmed'].includes(scenario))
  await new Promise((resolve) => setTimeout(resolve, 20000));
if (scenario === 'quota') {
  process.stderr.write('quota exceeded');
  process.exitCode = 1;
} else if (scenario === 'auth') {
  process.stderr.write('authentication failed SYNTHETIC_SECRET_AUTH');
  process.exitCode = 1;
} else if (scenario === 'config') {
  process.stderr.write(
    'warning: ignored config option SYNTHETIC_SECRET_CONFIG\n',
  );
  process.exitCode = 2;
} else if (scenario === 'schema') {
  process.stderr.write('Invalid schema SYNTHETIC_SECRET_SCHEMA\n');
  process.exitCode = 2;
} else if (scenario === 'exit2') process.exitCode = 2;
else if (scenario === 'provider-error')
  console.log(
    JSON.stringify({
      type: 'error',
      message: 'Unclassified SYNTHETIC_SECRET_PROVIDER',
    }),
  );
else if (scenario === 'turn-failed') {
  for (const e of [
    { type: 'thread.started', thread_id: 'synthetic' },
    { type: 'turn.started' },
    {
      type: 'turn.failed',
      error: { message: 'Unclassified SYNTHETIC_SECRET_PROVIDER' },
    },
  ])
    console.log(JSON.stringify(e));
} else if (scenario === 'malformed')
  console.log('not json SYNTHETIC_SECRET_MALFORMED');
else if (scenario === 'oversized') console.log('x'.repeat(200000));
else if (scenario === 'tool')
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'not executed' },
    }),
  );
else {
  for (const e of successEvents(brief)) console.log(JSON.stringify(e));
}
