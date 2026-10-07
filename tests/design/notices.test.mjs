import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { outputParser } from '../../agent/codex/jsonl.mjs';
import {
  createInvocation,
  validInvocation,
  validDiagnostic,
} from '../../agent/codex/invocation-receipt.mjs';
import { brief } from './fixtures.mjs';
import { successEvents, officialUsage } from './protocol-fixtures.mjs';
import {
  errorItem,
  noticeCases,
  forbiddenItems,
} from './upstream-jsonl-fixtures.mjs';
const line = (v) => JSON.stringify(v);
const stream = (events, eol = '\n') =>
  Buffer.from(events.map(line).join(eol) + eol);
const hash = (b) =>
  createHash('sha256').update(b.subarray(0, 4096)).digest('hex');
const observer = () =>
  createInvocation({
    jobId: 'job_' + '1'.repeat(32),
    attempt: 1,
    runtimeSha256: 'a'.repeat(64),
    inputSha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
    jobSpecSha256: 'd'.repeat(64),
  });
function rejected(chunks, channel = 'stdout') {
  const record = observer(),
    parser = outputParser(brief, record);
  let failure;
  try {
    for (const chunk of chunks) parser[channel](chunk);
    parser.finish({ code: 0, signalCode: null });
  } catch (e) {
    failure = e;
  }
  assert.ok(failure);
  // Rejected streams are sticky; a later success cannot erase the failure.
  assert.throws(
    () => parser.stdout(stream(successEvents())),
    (e) => e === failure,
  );
  const receipt = record.finish(failure);
  assert.equal(validInvocation(receipt), true);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /SYNTHETIC_SECRET|synthetic-a|synthetic-b|invalid global instructions/,
  );
  return receipt;
}
void test('pinned upstream warning/error items before thread, before turn and within turn are protocol-valid policy denials', () => {
  for (const [name, message, code, reason, category] of noticeCases) {
    for (let prefix = 0; prefix <= 2; prefix++) {
      const warning = errorItem(message),
        events = [...successEvents().slice(0, prefix), warning];
      const r = rejected([stream(events)]),
        d = r.primary;
      assert.equal(r.errorCode, code, name);
      assert.equal(d.source, 'provider_event');
      assert.equal(d.category, category);
      assert.equal(d.parser.reasonId, reason);
      assert.equal(d.parser.state, ['initial', 'thread', 'turn'][prefix]);
      assert.equal(d.parser.lineNumber, prefix + 1);
      assert.equal(d.parser.eventType, 'item.completed');
      assert.equal(d.parser.itemType, 'error');
      assert.equal(d.byteLength, Buffer.byteLength(line(warning)));
      assert.equal(d.fingerprint, hash(Buffer.from(line(warning))));
      assert.equal(r.lastValidEvent, 'item.completed');
      assert.equal(r.terminalSeen, false);
      assert.equal(r.usage, null);
    }
  }
});
void test('one rejected UTF-8 event has identical exact diagnostics across line/coalesced/split/bytewise/CRLF delivery', () => {
  const warning = errorItem(noticeCases.at(-1)[1]);
  const preceding = stream(successEvents().slice(0, 2));
  const bad = stream([warning]);
  const together = Buffer.concat([preceding, bad, stream(successEvents())]);
  const variants = [
    [preceding, bad],
    [together],
    [preceding, bad.subarray(0, -1), bad.subarray(-1)],
    Array.from(together, (b) => Buffer.from([b])),
    [stream([...successEvents().slice(0, 2), warning], '\r\n')],
  ];
  const expected = rejected(variants[0]).primary;
  for (const chunks of variants)
    assert.deepEqual(rejected(chunks).primary, expected);
  // Every split of the bad line, including the interior of a multibyte codepoint.
  for (let i = 1; i < bad.length; i++)
    assert.deepEqual(
      rejected([preceding, bad.subarray(0, i), bad.subarray(i)]).primary,
      expected,
    );
  assert.equal(expected.parser.byteScope, 'complete_line');
});
void test('malformed JSON, unknown enums/fields, forbidden actions and order failures remain distinct and bounded', () => {
  const prefix = stream(successEvents().slice(0, 2));
  const cases = [
    ['{"SYNTHETIC_SECRET_MALFORMED"\n', 'MALFORMED_JSON', null, null, 0],
    [
      stream([{ type: 'SYNTHETIC_SECRET_EVENT', SYNTHETIC_SECRET_FIELD: 1 }]),
      'UNKNOWN_EVENT_TYPE',
      'unknown',
      null,
      1,
    ],
    [
      stream([
        {
          type: 'item.completed',
          item: {
            id: 'x',
            type: 'SYNTHETIC_SECRET_ITEM',
            SYNTHETIC_SECRET_FIELD: 1,
          },
        },
      ]),
      'UNKNOWN_ITEM_TYPE',
      'item.completed',
      'unknown',
      1,
    ],
    [
      stream([{ ...errorItem(), SYNTHETIC_SECRET_FIELD: true }]),
      'UNEXPECTED_FIELDS',
      'item.completed',
      'error',
      1,
    ],
    [
      stream([
        {
          type: 'item.completed',
          item: { id: 'x', type: 'error', message: 42 },
        },
      ]),
      'INVALID_ITEM_SHAPE',
      'item.completed',
      'error',
      0,
    ],
    [
      stream([{ ...errorItem(), type: 'item.started' }]),
      'INVALID_EVENT_ORDER',
      'item.started',
      'error',
      0,
    ],
    ...forbiddenItems.map((type) => [
      stream([{ type: 'item.completed', item: { id: 'x', type } }]),
      'FORBIDDEN_ACTION',
      'item.completed',
      type,
      0,
    ]),
  ];
  for (const [bytes, reason, eventType, itemType, count] of cases) {
    const d = rejected([prefix, Buffer.from(bytes)]).primary;
    assert.equal(d.parser.reasonId, reason);
    assert.equal(d.parser.eventType, eventType);
    assert.equal(d.parser.itemType, itemType);
    assert.equal(d.parser.unknownFieldCount, count);
  }
});
void test('invalid UTF-8, unterminated lines and fixed byte limits report deterministic partial prefixes, never whole chunks', () => {
  const cases = [
    [Buffer.from([0x61, 0xc3, 0xff, 0x78]), 'INVALID_UTF8', 3],
    [Buffer.from([0xc3]), 'INVALID_UTF8', 1],
    [Buffer.from('{"type":"error"}'), 'UNTERMINATED_LINE', 16],
    [Buffer.from('x'.repeat(30000)), 'LINE_LIMIT', 20001],
  ];
  for (const [bytes, reason, size] of cases) {
    const expected = rejected([bytes]).primary;
    assert.equal(expected.parser.reasonId, reason);
    assert.equal(expected.parser.byteScope, 'partial_line');
    assert.equal(expected.byteLength, size);
    assert.equal(expected.fingerprint, hash(bytes.subarray(0, size)));
    assert.deepEqual(
      rejected(Array.from(bytes, (b) => Buffer.from([b]))).primary,
      expected,
    );
  }
  const messages = successEvents().slice(0, 2);
  for (let i = 0; i < 99; i++)
    messages.push({
      type: 'item.completed',
      item: { id: 'r' + i, type: 'reasoning', text: '' },
    });
  assert.equal(
    rejected([stream(messages)]).primary.parser.reasonId,
    'LINE_COUNT_LIMIT',
  );
  const large = successEvents().slice(0, 2);
  for (let i = 0; i < 8; i++)
    large.push({
      type: 'item.completed',
      item: { id: 'r' + i, type: 'reasoning', text: 'x'.repeat(19000) },
    });
  const all = stream(large),
    limit = rejected([all]).primary;
  assert.equal(limit.parser.reasonId, 'STREAM_LIMIT');
  assert.equal(limit.parser.byteScope, 'partial_line');
  assert.deepEqual(
    rejected(Array.from(all, (b) => Buffer.from([b]))).primary,
    limit,
  );
  const empty = rejected([]).primary;
  assert.equal(empty.parser.reasonId, 'INCOMPLETE_STREAM');
  assert.equal(empty.parser.byteScope, 'stream_end');
  assert.equal(empty.byteLength, 0);
});
void test('stderr line diagnostics are chunk-invariant, secret-free; only existing exact stdin banner may continue', () => {
  const b = Buffer.from('authentication failed SYNTHETIC_SECRET_STDERR\n');
  const first = Buffer.from('Reading prompt from stdin...\n');
  const expected = rejected([first, b], 'stderr').primary;
  assert.equal(expected.parser.lineNumber, 2);
  assert.equal(expected.parser.stream, 'stderr');
  for (const chunks of [
    [Buffer.concat([first, b])],
    Array.from(Buffer.concat([first, b]), (n) => Buffer.from([n])),
  ])
    assert.deepEqual(rejected(chunks, 'stderr').primary, expected);
  const o = observer(),
    p = outputParser(brief, o);
  p.stderr(first);
  p.stdout(stream(successEvents()));
  assert.equal(
    p.finish({ code: 0, signalCode: null }).proposal.concepts.length,
    3,
  );
  assert.deepEqual(o.finish().usage, officialUsage);
  const noNewline = b.subarray(0, -1);
  const partial = rejected([noNewline], 'stderr').primary;
  assert.equal(partial.primaryCode, 'CODEX_LOGIN_REQUIRED');
  assert.equal(partial.parser.reasonId, 'NOTICE_AUTH');
  assert.equal(partial.parser.byteScope, 'partial_line');
  assert.equal(partial.fingerprint, hash(noNewline));
  assert.deepEqual(
    rejected(
      Array.from(noNewline, (n) => Buffer.from([n])),
      'stderr',
    ).primary,
    partial,
  );
});
void test('extended receipts reject arbitrary diagnostic values and keep legacy and primary-before-cleanup compatibility', () => {
  const receipt = rejected([stream([errorItem()])]);
  const legacy = structuredClone(receipt.primary);
  delete legacy.parser;
  assert.equal(validDiagnostic(legacy), true);
  for (const [key, value] of [
    ['reasonId', 'SYNTHETIC_SECRET'],
    ['eventType', 'SYNTHETIC_SECRET'],
    ['itemType', 'SYNTHETIC_SECRET'],
    ['unknownFieldCount', 10001],
    ['lineNumber', 0],
    ['state', 'SYNTHETIC_SECRET'],
    ['byteScope', 'chunk'],
  ]) {
    const invalid = structuredClone(receipt.primary);
    invalid.parser[key] = value;
    assert.equal(validDiagnostic(invalid), false);
  }
  const o = observer();
  o.failure({ diagnostic: receipt.primary });
  o.process({ confirmed: false, cleanupCode: 'STOP_UNCONFIRMED' });
  const stopped = o.finish({ code: 'STOP_UNCONFIRMED' });
  assert.equal(stopped.errorCode, 'STOP_UNCONFIRMED');
  assert.deepEqual(stopped.primary, receipt.primary);
  assert.equal(validInvocation(stopped), true);
});
