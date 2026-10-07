import { TextDecoder } from 'node:util';
import { assertProposal } from '../../server/design/contract.mjs';
import {
  diagnostic,
  diagnosticError,
  validDiagnostic,
  validUsage,
  USAGE_KEYS,
  knownEventType,
  knownItemType,
  parserDiagnostic,
} from './invocation-receipt.mjs';

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

// The producer loses the Warning/ConfigWarning/DeprecationNotice distinction.
// No error-item message is currently proven harmless, so none grants continuation.
function noticePolicy(text) {
  if (/^model rerouted:/i.test(text.trim()))
    return ['CODEX_MODEL_CAPABILITY_MISMATCH', 'MODEL_REROUTED', 'config'];
  if (
    /lagged|(?:lost|dropped|missed|skipped).*events?|events?.*(?:lost|dropped|missed)/i.test(
      text,
    )
  )
    return ['CODEX_PROCESS_FAILED', 'EVENTS_LOST', 'protocol'];
  if (
    /unknown.*(config|option)|unrecognized|ignor(ed|ing).*(config|setting)|failed to (apply|load)|unsupported.*(config|setting)|invalid.*(config|instructions)|config(?:uration)? warning/i.test(
      text,
    )
  )
    return ['CODEX_SAFE_PROFILE_UNVERIFIED', 'NOTICE_CONFIG', 'config'];
  if (/quota|usage limit|limit exceeded/i.test(text))
    return ['CODEX_QUOTA', 'NOTICE_QUOTA', 'quota'];
  if (/not logged in|authentication|unauthorized|login required/i.test(text))
    return ['CODEX_LOGIN_REQUIRED', 'NOTICE_AUTH', 'auth'];
  if (/invalid (json )?schema/i.test(text))
    return ['CODEX_INVALID_OUTPUT', 'OUTPUT_SCHEMA', 'schema'];
  return ['CODEX_PROCESS_FAILED', 'NOTICE_UNKNOWN', 'unclassified'];
}
export function diagnosticCode(text) {
  if (text.trim() === '' || text.trim() === 'Reading prompt from stdin...')
    return null;
  return noticePolicy(text)[0];
}
export function streamDiagnostic(text, source) {
  if (!diagnosticCode(text)) return null;
  const [code, , category] = noticePolicy(text);
  return diagnostic({ code }, { source, stage: 'stream', category, text });
}

// Fixed-size byte framing, with incremental fatal UTF-8 validation. Stop at the
// first offending byte, regardless of chunk coalescing. LF/CRLF are not content.
function lineStream(consume, reject, maxLine, maxLines) {
  const storage = Buffer.alloc(maxLine + 2);
  const decoder = () =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let utf8 = decoder(),
    length = 0,
    lines = 0,
    total = 0;
  const prefix = () => storage.subarray(0, length);
  return {
    nextLine: () => lines + 1,
    push(chunk) {
      for (const byte of chunk) {
        storage[length++] = byte;
        if (++total > 131072)
          reject('STREAM_LIMIT', prefix(), lines + 1, 'partial_line');
        try {
          utf8.decode(Buffer.from([byte]), { stream: true });
        } catch {
          reject('INVALID_UTF8', prefix(), lines + 1, 'partial_line');
        }
        if (byte === 10) {
          let end = length - 1;
          if (end && storage[end - 1] === 13) end--;
          const bytes = storage.subarray(0, end);
          if (++lines > maxLines)
            reject('LINE_COUNT_LIMIT', bytes, lines, 'complete_line');
          consume(bytes, lines);
          length = 0;
          utf8 = decoder();
        } else if (
          length > maxLine &&
          !(length === maxLine + 1 && byte === 13)
        ) {
          reject('LINE_LIMIT', prefix(), lines + 1, 'partial_line');
        }
      }
    },
    end() {
      try {
        utf8.decode();
      } catch {
        reject('INVALID_UTF8', prefix(), lines + 1, 'partial_line');
      }
      if (length)
        reject('UNTERMINATED_LINE', prefix(), lines + 1, 'partial_line');
    },
  };
}

export function outputParser(brief, observer) {
  let state = 'initial',
    proposal,
    usage = null,
    failed;
  const ids = new Set();
  const context = (stream, lineNumber, byteScope) => ({
    stream,
    state,
    lineNumber,
    byteScope,
    eventType: null,
    itemType: null,
    unknownFieldCount: 0,
  });
  const reject = (
    bytes,
    ctx,
    reasonId,
    code = 'CODEX_INVALID_OUTPUT',
    options = {},
  ) => {
    throw diagnosticError(
      code,
      parserDiagnostic(code, bytes, { ...ctx, reasonId }, options),
    );
  };
  const framing = (stream) => (reason, bytes, number, scope) => {
    // stderr is not JSONL. EOF diagnostics may omit newline; retain their cause
    // without claiming this partial prefix was a complete framed message.
    if (stream === 'stderr' && reason === 'UNTERMINATED_LINE') {
      const text = bytes.toString('utf8');
      if (diagnosticCode(text)) {
        const [code, policyReason, category] = noticePolicy(text);
        reject(
          bytes,
          context(stream, number, scope),
          policyReason === 'NOTICE_UNKNOWN' ? 'STDERR_UNKNOWN' : policyReason,
          code,
          { source: 'stderr', stage: 'stream', category },
        );
      }
    }
    reject(
      bytes,
      context(stream, number, scope),
      reason,
      reason.endsWith('LIMIT') ? 'CODEX_OUTPUT_LIMIT' : 'CODEX_INVALID_OUTPUT',
    );
  };
  const stdout = lineStream(
    (bytes, number) => {
      const ctx = context('stdout', number, 'complete_line');
      const bad = (reason, code, options) =>
        reject(bytes, ctx, reason, code, options);
      const shape = (value, keys, reason) => {
        if (!object(value)) bad(reason);
        ctx.unknownFieldCount += Object.keys(value).filter(
          (k) => !keys.includes(k),
        ).length;
        if (ctx.unknownFieldCount) bad('UNEXPECTED_FIELDS');
        if (!keys.every((k) => Object.hasOwn(value, k))) bad(reason);
      };
      const notice = (text, fallback = 'NOTICE_UNKNOWN') => {
        const [code, reason, category] = noticePolicy(text);
        bad(reason === 'NOTICE_UNKNOWN' ? fallback : reason, code, {
          source: 'provider_event',
          category,
        });
      };
      try {
        let e;
        try {
          e = JSON.parse(bytes.toString('utf8'));
        } catch {
          bad('MALFORMED_JSON');
        }
        if (!object(e) || typeof e.type !== 'string')
          bad('INVALID_EVENT_SHAPE');
        ctx.eventType = knownEventType(e.type);
        if (Object.hasOwn(e, 'item'))
          ctx.itemType = knownItemType(e.item?.type);
        if (ctx.eventType === 'unknown') {
          ctx.unknownFieldCount = Object.keys(e).filter(
            (k) => k !== 'type',
          ).length;
          bad('UNKNOWN_EVENT_TYPE');
        }
        if (state === 'done') bad('INVALID_EVENT_ORDER');
        if (e.type === 'error' || e.type === 'turn.failed') {
          shape(
            e,
            e.type === 'error' ? ['type', 'message'] : ['type', 'error'],
            'INVALID_EVENT_SHAPE',
          );
          if (e.type === 'turn.failed') {
            if (state !== 'turn') bad('INVALID_EVENT_ORDER');
            shape(e.error, ['message'], 'INVALID_EVENT_SHAPE');
          }
          const text = e.type === 'error' ? e.message : e.error.message;
          if (typeof text !== 'string') bad('INVALID_EVENT_SHAPE');
          observer?.event(e.type);
          observer?.terminal();
          notice(text, 'PROVIDER_ERROR');
        }
        if (e.type === 'thread.started') {
          shape(e, ['type', 'thread_id'], 'INVALID_EVENT_SHAPE');
          if (
            typeof e.thread_id !== 'string' ||
            !e.thread_id.length ||
            e.thread_id.length > 128
          )
            bad('INVALID_EVENT_SHAPE');
          if (state !== 'initial') bad('INVALID_EVENT_ORDER');
          observer?.event(e.type);
          state = 'thread';
          return;
        }
        if (e.type === 'turn.started') {
          shape(e, ['type'], 'INVALID_EVENT_SHAPE');
          if (state !== 'thread') bad('INVALID_EVENT_ORDER');
          observer?.event(e.type);
          state = 'turn';
          return;
        }
        if (
          ['item.started', 'item.updated', 'item.completed'].includes(e.type)
        ) {
          shape(e, ['type', 'item'], 'INVALID_EVENT_SHAPE');
          if (!object(e.item) || typeof e.item.type !== 'string')
            bad('INVALID_ITEM_SHAPE');
          const item = e.item;
          if (ctx.itemType === 'unknown') {
            ctx.unknownFieldCount = Object.keys(item).filter(
              (k) => !['id', 'type'].includes(k),
            ).length;
            bad('UNKNOWN_ITEM_TYPE');
          }
          // Recognize notices before the turn-only gate; never interpret them as tools.
          if (item.type === 'error') {
            shape(item, ['id', 'type', 'message'], 'INVALID_ITEM_SHAPE');
            if (
              typeof item.id !== 'string' ||
              !item.id.length ||
              item.id.length > 128 ||
              typeof item.message !== 'string'
            )
              bad('INVALID_ITEM_SHAPE');
            if (e.type !== 'item.completed') bad('INVALID_EVENT_ORDER');
            if (ids.has(item.id)) bad('DUPLICATE_ITEM');
            observer?.event(e.type);
            notice(item.message);
          }
          if (!['reasoning', 'agent_message'].includes(item.type))
            bad('FORBIDDEN_ACTION');
          if (state !== 'turn' || e.type !== 'item.completed')
            bad('INVALID_EVENT_ORDER');
          shape(item, ['id', 'type', 'text'], 'INVALID_ITEM_SHAPE');
          if (
            typeof item.id !== 'string' ||
            !item.id.length ||
            item.id.length > 128 ||
            typeof item.text !== 'string'
          )
            bad('INVALID_ITEM_SHAPE');
          if (ids.has(item.id)) bad('DUPLICATE_ITEM');
          ids.add(item.id);
          if (proposal) bad('MULTIPLE_ANSWERS');
          if (item.type === 'agent_message') {
            try {
              proposal = JSON.parse(item.text);
              assertProposal(proposal, brief);
            } catch {
              bad('INVALID_PROPOSAL');
            }
          }
          observer?.event(e.type);
          return;
        }
        if (e.type === 'turn.completed') {
          shape(e, ['type', 'usage'], 'INVALID_EVENT_SHAPE');
          if (state !== 'turn' || !proposal) bad('INVALID_EVENT_ORDER');
          shape(e.usage, USAGE_KEYS, 'INVALID_USAGE');
          if (!validUsage(e.usage)) bad('INVALID_USAGE');
          observer?.terminal();
          observer?.usage(e.usage);
          usage = {
            inputTokens: e.usage.input_tokens,
            outputTokens: e.usage.output_tokens,
          };
          observer?.event(e.type);
          state = 'done';
          return;
        }
        bad('INVALID_EVENT_ORDER');
      } catch (error) {
        if (validDiagnostic(error?.diagnostic)) throw error;
        bad('INTERNAL_PARSER_FAILURE', 'CODEX_PROCESS_FAILED', {
          category: 'unclassified',
        });
      }
    },
    framing('stdout'),
    20000,
    100,
  );
  const stderr = lineStream(
    (bytes, number) => {
      const line = bytes.toString('utf8');
      if (!diagnosticCode(line)) return;
      const [code, reason, category] = noticePolicy(line);
      reject(
        bytes,
        context('stderr', number, 'complete_line'),
        reason === 'NOTICE_UNKNOWN' ? 'STDERR_UNKNOWN' : reason,
        code,
        { source: 'stderr', stage: 'stream', category },
      );
    },
    framing('stderr'),
    4096,
    32,
  );
  const guarded = (fn) => {
    if (failed) throw failed;
    try {
      return fn();
    } catch (error) {
      const details = diagnostic(error, { source: 'parser', stage: 'parser' });
      failed = diagnosticError(details.primaryCode, details);
      observer?.failure(failed);
      throw failed;
    }
  };
  return {
    stdout: (chunk) => guarded(() => stdout.push(chunk)),
    stderr: (chunk) => guarded(() => stderr.push(chunk)),
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
        if (state !== 'done')
          reject(
            Buffer.alloc(0),
            context('stdout', stdout.nextLine(), 'stream_end'),
            'INCOMPLETE_STREAM',
          );
        return { proposal, usage };
      });
    },
  };
}
