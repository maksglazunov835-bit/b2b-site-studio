import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { boundedProcess, clientEnvironment } from '../agent/codex/adapter.mjs';
import { queryModelCatalog } from '../agent/codex/model-catalog.mjs';

const binary = process.argv[2];
if (!path.isAbsolute(binary ?? ''))
  throw new Error('Absolute official binary required');
try {
  const actual = await realpath(binary);
  const version = await boundedProcess(actual, ['--version']);
  const match = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(version.stdout);
  if (!match || version.code !== 0) throw new Error('Unsupported binary');
  const receipt = await queryModelCatalog(actual, clientEnvironment());
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        cliVersion: match[1],
        binarySha256: createHash('sha256')
          .update(await readFile(actual))
          .digest('hex'),
        ...receipt,
        modelInvocations: 0,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      status: e.code ?? 'CODEX_MODEL_QUERY_FAILED',
      modelInvocations: 0,
    }),
  );
  process.exitCode = 1;
}
