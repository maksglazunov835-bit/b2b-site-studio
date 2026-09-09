import { preflight, ISOLATION_STATUS } from '../agent/codex/adapter.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--codex-bin')
  throw new Error('Expected --codex-bin absolute-native-executable');
const runtime = await preflight(args[1]);
// No model invocation is authorized while the same-profile isolation canary fails.
console.log(
  JSON.stringify(
    {
      kind: 'official-local-smoke',
      runtime,
      isolationStatus: ISOLATION_STATUS,
      status: 'blocked',
      modelInvocations: 0,
      reason: runtime.status,
      evidence:
        'Official Windows permission-profile canaries did not deny outside reads or loopback access. See astra-isolation.md. No auth file was read or copied.',
    },
    null,
    2,
  ),
);
