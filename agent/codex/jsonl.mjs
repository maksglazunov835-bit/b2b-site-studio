import { TextDecoder } from 'node:util';
import { RunnerError } from '../transport.mjs';
import { assertProposal } from '../../server/design/contract.mjs';

const fail = (code = 'CODEX_INVALID_OUTPUT') => {
  throw new RunnerError(code);
};
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k));
export function diagnosticCode(text) {
  if (
    /unknown.*(config|option)|unrecognized|ignor(ed|ing).*(config|setting)|failed to (apply|load)|unsupported.*(config|setting)/i.test(
      text,
    )
  )
    return 'CODEX_SAFE_PROFILE_UNVERIFIED';
  if (/quota|usage limit|limit exceeded/i.test(text)) return 'CODEX_QUOTA';
  if (/not logged in|authentication|unauthorized|login required/i.test(text))
    return 'CODEX_LOGIN_REQUIRED';
  // Fixed non-secret diagnostic present in the inspected official binary.
  if (text.trim() === '' || text.trim() === 'Reading prompt from stdin...')
    return null;
  return 'CODEX_PROCESS_FAILED';
}
function lineStream(consume, maxLine, maxLines) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    lines = 0,
    bytes = 0;
  const drain = (text, final = false) => {
    buffer += text;
    let offset;
    while ((offset = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, offset).replace(/\r$/, '');
      buffer = buffer.slice(offset + 1);
      if (++lines > maxLines || Buffer.byteLength(line) > maxLine)
        fail('CODEX_OUTPUT_LIMIT');
      consume(line);
    }
    if (Buffer.byteLength(buffer) > maxLine) fail('CODEX_OUTPUT_LIMIT');
    if (final && buffer.length) {
      if (++lines > maxLines) fail('CODEX_OUTPUT_LIMIT');
      consume(buffer);
      buffer = '';
    }
  };
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes > 131072) fail('CODEX_OUTPUT_LIMIT');
      try {
        drain(decoder.decode(chunk, { stream: true }));
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        fail();
      }
    },
    end() {
      try {
        drain(decoder.decode(), true);
      } catch (e) {
        if (e instanceof RunnerError) throw e;
        fail();
      }
    },
  };
}

// Codex exec 0.153.4 JSONL: service/reasoning notifications are not executable items.
// Reasoning and diagnostics are consumed and discarded, never retained in the report.
export function outputParser(brief) {
  let state = 'initial',
    proposal,
    usage = null;
  const reasoning = new Map();
  const stdout = lineStream(
    (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        fail();
      }
      if (!e || typeof e.type !== 'string' || state === 'done') fail();
      if (e.type === 'error' || e.type === 'turn.failed') {
        const message = e.message ?? e.error?.message;
        fail(
          diagnosticCode(typeof message === 'string' ? message : '') ??
            'CODEX_PROCESS_FAILED',
        );
      }
      if (
        e.type === 'thread.started' &&
        state === 'initial' &&
        fields(e, ['type', 'thread_id']) &&
        typeof e.thread_id === 'string' &&
        e.thread_id.length <= 128
      ) {
        state = 'thread';
        return;
      }
      if (
        e.type === 'turn.started' &&
        state === 'thread' &&
        fields(e, ['type'])
      ) {
        state = 'turn';
        return;
      }
      if (state !== 'turn') fail();
      if (['item.started', 'item.updated', 'item.completed'].includes(e.type)) {
        if (!fields(e, ['type', 'item'])) fail();
        const item = e.item;
        if (item?.type !== 'reasoning' && item?.type !== 'agent_message')
          fail();
        if (
          !fields(item, ['id', 'type', 'text']) ||
          typeof item.id !== 'string' ||
          item.id.length > 128 ||
          typeof item.text !== 'string'
        )
          fail();
        if (item.type === 'reasoning') {
          if (proposal || reasoning.get(item.id) === 'done') fail();
          if (e.type === 'item.updated' && reasoning.get(item.id) !== 'active')
            fail();
          if (e.type === 'item.started' && reasoning.has(item.id)) fail();
          reasoning.set(
            item.id,
            e.type === 'item.completed' ? 'done' : 'active',
          );
          return;
        }
        if (
          e.type !== 'item.completed' ||
          proposal ||
          [...reasoning.values()].includes('active')
        )
          fail();
        try {
          proposal = JSON.parse(item.text);
          assertProposal(proposal, brief);
        } catch {
          fail();
        }
        return;
      }
      if (
        e.type === 'turn.completed' &&
        proposal &&
        fields(e, ['type', 'usage'])
      ) {
        if (e.usage !== undefined) {
          if (
            !fields(e.usage, [
              'input_tokens',
              'cached_input_tokens',
              'output_tokens',
            ]) ||
            !['input_tokens', 'output_tokens'].every(
              (k) => Number.isSafeInteger(e.usage[k]) && e.usage[k] >= 0,
            ) ||
            (e.usage.cached_input_tokens !== undefined &&
              (!Number.isSafeInteger(e.usage.cached_input_tokens) ||
                e.usage.cached_input_tokens < 0))
          )
            fail();
          usage = {
            inputTokens: e.usage.input_tokens,
            outputTokens: e.usage.output_tokens,
          };
        }
        state = 'done';
        return;
      }
      fail();
    },
    20000,
    100,
  );
  const stderr = lineStream(
    (line) => {
      const code = diagnosticCode(line);
      if (code) fail(code);
    },
    4096,
    32,
  );
  return {
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    finish(output) {
      stderr.end();
      stdout.end();
      if (output.code !== 0 || output.signalCode !== null)
        fail('CODEX_PROCESS_FAILED');
      if (state !== 'done') fail();
      return { proposal, usage };
    },
  };
}
