// Fixed test executable. No job/prompt fields choose fixtures or executables.
import { successEvents, fixtureScenarios } from './protocol-fixtures.mjs';
import { errorItem, noticeCases } from './upstream-jsonl-fixtures.mjs';
const scenario = process.argv[2];
if (!fixtureScenarios.includes(scenario)) throw Error('Invalid test scenario');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (scenario.startsWith('notice-')) {
  const kind = scenario.slice('notice-'.length);
  const selected = noticeCases.find(([name]) => name === kind);
  const events = [
    ...successEvents().slice(0, kind === 'turn' ? 2 : 1),
    errorItem(selected?.[1]),
  ];
  const eol = kind === 'pre-crlf' ? '\r\n' : '\n';
  const lines = events.map((e) => Buffer.from(JSON.stringify(e) + eol));
  const all = Buffer.concat(lines);
  const chunks =
    kind === 'pre-bytewise'
      ? Array.from(all, (b) => Buffer.from([b]))
      : kind === 'pre-coalesced'
        ? [all]
        : kind === 'pre-split'
          ? [all.subarray(0, -1), all.subarray(-1)]
          : lines;
  for (const chunk of chunks) {
    process.stdout.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
} else if (scenario === 'unknown-event')
  emit({ type: 'SYNTHETIC_SECRET_TYPE', SYNTHETIC_SECRET_FIELD: true });
else if (scenario === 'forbidden-action') {
  for (const e of successEvents().slice(0, 2)) emit(e);
  emit({
    type: 'item.started',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'SYNTHETIC_SECRET_COMMAND',
      status: 'in_progress',
      aggregated_output: '',
      exit_code: null,
    },
  });
} else if (scenario === 'invalid-utf8')
  process.stdout.write(Buffer.from([0xc3, 0xff]));
else if (scenario === 'truncated')
  process.stdout.write('{"type":"SYNTHETIC_SECRET_TRUNCATED"');
else if (scenario === 'timeout') await new Promise((r) => setTimeout(r, 20000));
else if (scenario === 'exit2') process.exitCode = 2;
else if (['config', 'auth', 'quota', 'schema'].includes(scenario)) {
  process.stderr.write(
    {
      config: 'warning: ignored config option',
      auth: 'authentication failed',
      quota: 'quota exceeded',
      schema: 'Invalid schema',
    }[scenario] + ' SYNTHETIC_SECRET_STDERR\n',
  );
  process.exitCode = 2;
} else if (scenario === 'provider-error')
  emit({ type: 'error', message: 'SYNTHETIC_SECRET_PROVIDER unknown failure' });
else if (scenario === 'turn-failed') {
  emit({ type: 'thread.started', thread_id: 'synthetic' });
  emit({ type: 'turn.started' });
  emit({
    type: 'turn.failed',
    error: { message: 'SYNTHETIC_SECRET_PROVIDER unknown failure' },
  });
} else if (scenario === 'malformed')
  process.stdout.write('SYNTHETIC_SECRET_MALFORMED\n');
else if (scenario === 'oversized') process.stdout.write('S'.repeat(300000));
else for (const event of successEvents()) emit(event);
