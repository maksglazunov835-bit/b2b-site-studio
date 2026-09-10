// Fixed test executable. No job/prompt fields choose fixtures or executables.
import { successEvents, fixtureScenarios } from './protocol-fixtures.mjs';
const scenario = process.argv[2];
if (!fixtureScenarios.includes(scenario)) throw Error('Invalid test scenario');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (scenario === 'timeout') await new Promise((r) => setTimeout(r, 20000));
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
