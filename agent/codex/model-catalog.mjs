import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunnerError } from '../transport.mjs';

export const TARGET_MODEL = 'gpt-6-astra';
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function selectAstra(rows) {
  const matches = rows.filter((r) => r.model === TARGET_MODEL && !r.hidden);
  if (matches.length !== 1) throw new RunnerError('CODEX_MODEL_NOT_AVAILABLE');
  const model = matches[0];
  const supported = model.supportedReasoningEfforts?.map(
    (e) => e.reasoningEffort,
  );
  if (
    !Array.isArray(supported) ||
    !supported.length ||
    supported.some((e) => !efforts.includes(e)) ||
    new Set(supported).size !== supported.length ||
    !Array.isArray(model.inputModalities) ||
    !model.inputModalities.includes('text')
  )
    throw new RunnerError('CODEX_MODEL_CAPABILITY_MISMATCH');
  return {
    requestedModel: TARGET_MODEL,
    resolvedModel: model.model,
    supportedReasoningEfforts: [...new Set(supported)],
    effort: efforts.filter((e) => supported.includes(e)).at(-1),
    inputModalities: model.inputModalities.filter((m) =>
      ['text', 'image'].includes(m),
    ),
    source: 'official_model_list',
    inferenceAccessVerified: false,
  };
}

// Read-only control-plane RPC. Never starts/resumes a thread, invokes tools, or reads auth files.
export async function queryModelCatalog(
  binary,
  env,
  { timeoutMs = 15000, spawnProcess = spawn } = {},
) {
  const root = await realpath(tmpdir());
  const cwd = await mkdtemp(path.join(root, 'b2b-model-catalog-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(
        binary,
        ['app-server', '--listen', 'stdio://'],
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let buffer = '',
        bytes = 0,
        id = 0,
        pages = 0,
        failure,
        result;
      let phase = 'initialize';
      const rows = [],
        cursors = new Set();
      const fail = (code) => {
        failure ??= new RunnerError(code);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
      };
      const timer = setTimeout(
        () => fail('CODEX_MODEL_QUERY_FAILED'),
        timeoutMs,
      );
      const send = (method, params) =>
        child.stdin.write(JSON.stringify({ id: ++id, method, params }) + '\n');
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 262144) return fail('CODEX_MODEL_QUERY_FAILED');
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const r = JSON.parse(line);
            if (r.id === undefined) continue;
            if (r.id !== id || r.error || !r.result)
              return fail('CODEX_MODEL_QUERY_FAILED');
            if (phase === 'initialize') {
              child.stdin.write(
                JSON.stringify({ method: 'initialized' }) + '\n',
              );
              phase = 'account';
              send('account/read', { refreshToken: false });
            } else if (phase === 'account') {
              if (r.result.account?.type !== 'chatgpt')
                return fail('CODEX_AUTH_UNSUPPORTED');
              phase = 'models';
              send('model/list', { limit: 20, includeHidden: false });
            } else if (phase === 'models') {
              if (
                !Array.isArray(r.result.data) ||
                r.result.data.length > 100 ||
                ++pages > 10
              )
                return fail('CODEX_MODEL_QUERY_FAILED');
              rows.push(...r.result.data);
              const cursor = r.result.nextCursor;
              if (cursor !== null) {
                if (
                  typeof cursor !== 'string' ||
                  cursor.length > 1024 ||
                  cursors.has(cursor)
                )
                  return fail('CODEX_MODEL_QUERY_FAILED');
                cursors.add(cursor);
                send('model/list', { limit: 20, includeHidden: false, cursor });
              } else {
                result = {
                  accountType: 'chatgpt',
                  pages,
                  ...selectAstra(rows),
                };
                phase = 'done';
                child.stdin.end();
              }
            } else return fail('CODEX_MODEL_QUERY_FAILED');
          } catch (e) {
            return fail(
              e instanceof RunnerError ? e.code : 'CODEX_MODEL_QUERY_FAILED',
            );
          }
        }
        if (buffer.length > 131072) fail('CODEX_MODEL_QUERY_FAILED');
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 262144) fail('CODEX_MODEL_QUERY_FAILED');
      });
      child.stdin.on('error', () => fail('CODEX_MODEL_QUERY_FAILED'));
      child.once('error', () => fail('CODEX_NOT_AVAILABLE'));
      child.once('close', (code) => {
        clearTimeout(timer);
        if (failure || code !== 0 || !result)
          reject(failure ?? new RunnerError('CODEX_MODEL_QUERY_FAILED'));
        else resolve(result);
      });
      send('initialize', {
        clientInfo: { name: 'b2b_model_probe', version: '1.0.0' },
      });
    });
  } finally {
    if (path.dirname(cwd) === root && (await realpath(cwd)) === cwd)
      await rm(cwd, { recursive: true });
  }
}
