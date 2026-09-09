import { officialAdapter } from '../agent/codex/adapter.mjs';
const args = process.argv.slice(2);
let adapter;
if (args.length === 1 && args[0] === '--codex-wsl')
  adapter = await officialAdapter(null, { transport: 'wsl' });
else if (args.length === 2 && args[0] === '--codex-bin')
  adapter = await officialAdapter(args[1]);
else
  throw Error('Expected --codex-wsl or --codex-bin absolute-native-executable');
console.log(
  JSON.stringify(
    {
      kind: 'official-local-preflight',
      runtime: adapter.runtime,
      diagnostics: adapter.diagnostics ?? null,
      modelInvocations: 0,
    },
    null,
    2,
  ),
);
if (adapter.runtime.status !== 'ready') process.exitCode = 1;
