import { preflight, SAFE_PROFILE_VERIFIED } from '../agent/codex/adapter.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--codex-bin')
  throw new Error('Expected --codex-bin absolute-native-executable');
const runtime = await preflight(args[1]);
// No invocation is authorized until effective empty tools/config isolation can be proven.
console.log(
  JSON.stringify(
    {
      kind: 'official-local-smoke',
      runtime,
      safeProfileVerified: SAFE_PROFILE_VERIFIED,
      status: 'blocked',
      modelInvocations: 0,
      reason: runtime.status,
      evidence:
        'Installed 0.153.4 catalog exposes apply_patch freeform; no verified effective empty-tool profile. No auth file was read or copied.',
    },
    null,
    2,
  ),
);
