import { TextDecoder } from 'node:util';
import { RunnerError } from '../transport.mjs';
import { assertProposal } from '../../server/design/contract.mjs';
import {
  diagnostic,
  diagnosticError,
  validUsage,
} from './invocation-receipt.mjs';

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
export function streamDiagnostic(text, source) {
  let code = diagnosticCode(text);
  if (!code) return null;
  let category =
    {
      CODEX_SAFE_PROFILE_UNVERIFIED: 'config',
      CODEX_QUOTA: 'quota',
      CODEX_LOGIN_REQUIRED: 'auth',
    }[code] ?? 'unclassified';
  if (/invalid (json )?schema/i.test(text)) {
    code = 'CODEX_INVALID_OUTPUT';
    category = 'schema';
  }
  return diagnostic({ code }, { source, stage: 'stream', category, text });
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
      let text;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch { fail(); }
      drain(text);
    },
    end() {
      let text;
      try {
        text = decoder.decode();
      } catch { fail(); }
      drain(text, true);
    },
  };
}

// Codex exec 0.153.4 JSONL: service/reasoning notifications are not executable items.
// Reasoning and diagnostics are consumed and discarded, never retained in the report.
export function outputParser(brief, observer) {
  let state = 'initial',
    proposal,
    usage = null;
  const reasoning = new Map();
  const rejectDiagnostic = (details) => {
    const error = diagnosticError(details.primaryCode, details);
    observer?.failure(error);
    throw error;
  };
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
        if (
          e.type === 'error'
            ? !fields(e, ['type', 'message']) || typeof e.message !== 'string'
            : state !== 'turn' ||
              !fields(e, ['type', 'error']) ||
              !fields(e.error, ['message']) ||
              typeof e.error.message !== 'string'
        )
          fail();
        observer?.event(e.type);
        observer?.terminal();
        const text = e.type === 'error' ? e.message : e.error.message;
        rejectDiagnostic(
          streamDiagnostic(text, 'provider_event') ??
            diagnostic(
              { code: 'CODEX_PROCESS_FAILED' },
              { source: 'provider_event', text },
            ),
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
        observer?.event(e.type);
        return;
      }
      if (
        e.type === 'turn.started' &&
        state === 'thread' &&
        fields(e, ['type'])
      ) {
        state = 'turn';
        observer?.event(e.type);
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
          observer?.event(e.type);
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
        observer?.event(e.type);
        return;
      }
      if (
        e.type === 'turn.completed' &&
        proposal &&
        fields(e, ['type', 'usage'])
      ) {
        observer?.terminal();
        if (!validUsage(e.usage)) fail();
        {
          observer?.usage(e.usage);
          usage = {
            inputTokens: e.usage.input_tokens,
            outputTokens: e.usage.output_tokens,
          };
        }
        state = 'done';
        observer?.event(e.type);
        return;
      }
      fail();
    },
    20000,
    100,
  );
  const stderr = lineStream(
    (line) => {
      const details = streamDiagnostic(line, 'stderr');
      if (details) rejectDiagnostic(details);
    },
    4096,
    32,
  );
  const guarded = (fn, bytes) => {
    try {
      return fn();
    } catch (error) {
      const details = diagnostic(error, {
        source: 'parser',
        stage: 'parser',
        category: error instanceof RunnerError ? 'protocol' : 'unclassified',
        text: error instanceof RunnerError ? bytes?.toString('utf8') : undefined,
      });
      observer?.failure(diagnosticError(details.primaryCode, details));
      throw diagnosticError(details.primaryCode, details);
    }
  };
  return {
    stdout: (chunk) => guarded(() => stdout.push(chunk), chunk),
    stderr: (chunk) => guarded(() => stderr.push(chunk), chunk),
    finish(output) {
      return guarded(() => {
        stderr.end();
        stdout.end();
        if (output.code !== 0 || output.signalCode !== null)
          throw diagnosticError(
            'CODEX_PROCESS_FAILED',
            diagnostic(
              { code: 'CODEX_PROCESS_FAILED' },
              { source: 'cli_exit', stage: 'process_exit' },
            ),
          );
        if (state !== 'done') fail();
        return { proposal, usage };
      });
    },
  };
}
