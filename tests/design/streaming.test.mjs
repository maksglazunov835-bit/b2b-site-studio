import test from 'node:test';
import assert from 'node:assert/strict';
import { outputParser, diagnosticCode } from '../../agent/codex/jsonl.mjs';
import { brief, proposal } from './fixtures.mjs';
const events = () => [
  { type: 'thread.started', thread_id: 'synthetic' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'reason',
      type: 'reasoning',
      text: 'Synthetic reasoning: NEVER STORE',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'answer',
      type: 'agent_message',
      text: JSON.stringify(proposal()),
    },
  },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 2,
      reasoning_output_tokens: 1,
    },
  },
];
const jsonl = (list) =>
  Buffer.from(list.map((e) => JSON.stringify(e)).join('\n') + '\n');
const ok = { code: 0, signalCode: null };
void test('synthetic reasoning notification is discarded; every UTF-8 byte boundary streams correctly', () => {
  const list = events();
  list[2].item.text += ' \u041f\u0440\u0438\u0432\u0435\u0442';
  const parser = outputParser(brief);
  for (const byte of jsonl(list)) parser.stdout(Buffer.from([byte]));
  const result = parser.finish(ok);
  assert.equal(result.proposal.concepts.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /NEVER STORE|reasoning/);
});
void test('incremental limits enforce line/count/bytes before final or newline', () => {
  assert.throws(
    () => outputParser(brief).stdout(Buffer.from('x'.repeat(20001))),
    (e) => e.code === 'CODEX_OUTPUT_LIMIT',
  );
  assert.throws(
    () => outputParser(brief).stdout(Buffer.alloc(131073)),
    (e) => e.code === 'CODEX_OUTPUT_LIMIT',
  );
  const p = outputParser(brief);
  p.stdout(jsonl(events().slice(0, 2)));
  assert.throws(
    () => {
      for (let i = 0; i < 101; i++)
        p.stdout(
          jsonl([
            {
              type: 'item.completed',
              item: { type: 'reasoning', id: `r${i}`, text: '' },
            },
          ]),
        );
    },
    (e) => e.code === 'CODEX_OUTPUT_LIMIT',
  );
  assert.throws(() => outputParser(brief).stdout(Buffer.from([0xff])));
});
void test('order, repeated terminal, unknown event and executable notifications are refused early', () => {
  for (const list of [
    events().slice(1),
    [...events(), events()[4]],
    [...events(), events()[0]],
    [
      ...events().slice(0, 2),
      { type: 'item.completed', item: { type: 'command_execution' } },
    ],
    [...events().slice(0, 2), { type: 'unknown' }],
    [...events().slice(0, 4), events()[3]],
  ])
    assert.throws(
      () => outputParser(brief).stdout(jsonl(list)),
      (e) => e.code === 'CODEX_INVALID_OUTPUT',
    );
});
void test('safe stdin diagnostic, critical ignored config, auth, quota and unknown diagnostics differ', () => {
  assert.equal(diagnosticCode('Reading prompt from stdin...'), null);
  const p = outputParser(brief);
  p.stderr(Buffer.from('Reading prompt from stdin...\n'));
  p.stdout(jsonl(events()));
  assert.equal(p.finish(ok).proposal.concepts.length, 3);
  for (const [text, code] of [
    ['warning: ignored config option', 'CODEX_SAFE_PROFILE_UNVERIFIED'],
    ['authentication failed', 'CODEX_LOGIN_REQUIRED'],
    ['usage limit reached', 'CODEX_QUOTA'],
    ['unknown warning', 'CODEX_PROCESS_FAILED'],
  ])
    assert.throws(
      () => outputParser(brief).stderr(Buffer.from(text + '\n')),
      (e) => e.code === code,
    );
});
