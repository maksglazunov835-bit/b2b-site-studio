import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = new URL('../../', import.meta.url);
const sources = [
  'docs/contracts/design-job.schema.json',
  'docs/contracts/design-job-astra.schema.json',
  'docs/contracts/design-proposal.schema.json',
  'server/design/contract.mjs',
  'agent/codex/adapter.mjs',
  'agent/codex/wsl-policy.mjs',
  'agent/codex/wsl-runtime.mjs',
  'agent/codex/wsl-bridge.mjs',
  'agent/codex/wsl-supervisor.py',
  'agent/codex/model-catalog.mjs',
  'agent/codex/permission-profile.mjs',
  'agent/codex/bounded-process.mjs',
  'agent/codex/WindowsJob.cs',
  'agent/codex/jsonl.mjs',
  'agent/design-connect.mjs',
  'agent/design-main.mjs',
  'agent/session.mjs',
  'agent/data-session.mjs',
  'agent/protocol.mjs',
  'agent/transport.mjs',
];
export async function installedDesignManifest() {
  const files = [];
  for (const path of sources) {
    const value = (await readFile(new URL(path, root), 'utf8')).replaceAll(
      '\r\n',
      '\n',
    );
    files.push({
      path,
      sha256: createHash('sha256').update(value).digest('hex'),
    });
  }
  return {
    id: 'codex_design_exec',
    version: '1.1.0',
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const manifest = await installedDesignManifest();
  const target = new URL('server/design/adapter-manifest.json', root);
  if (process.argv[2] === '--write')
    await writeFile(target, JSON.stringify(manifest, null, 2) + '\n');
  else {
    if (
      JSON.stringify(JSON.parse(await readFile(target, 'utf8'))) !==
      JSON.stringify(manifest)
    )
      throw new Error('DESIGN_ADAPTER_MANIFEST_MISMATCH');
    console.log('DESIGN_ADAPTER_MANIFEST current');
  }
}
