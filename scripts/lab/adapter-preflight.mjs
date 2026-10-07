import { callLab } from '../../agent/codex/wsl-bridge.mjs';
try {
  const result = await callLab({ operation: 'preflight' });
  console.log(
    JSON.stringify({ kind: 'actual-windows-wsl-adapter', ...result }, null, 2),
  );
  if (result.status !== 'ready') process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      kind: 'actual-windows-wsl-adapter',
      status: error.code,
      modelInvocations: 0,
    }),
  );
  process.exitCode = 1;
}
