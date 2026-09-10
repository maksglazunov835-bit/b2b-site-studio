import test from 'node:test';
import assert from 'node:assert/strict';
import { outputParser } from '../../agent/codex/jsonl.mjs';
import { brief, proposal } from './fixtures.mjs';
import { officialUsage, successEvents } from './protocol-fixtures.mjs';
import {
  createInvocation,
  validInvocation,
} from '../../agent/codex/invocation-receipt.mjs';

void test('unexpected parser callback exception retains only an unclassified fingerprint', () => {
  let details;
  const parser = outputParser(brief, {event:()=>{throw Error('SYNTHETIC_SECRET_PARSER');},failure:error=>{details=error.diagnostic;}});
  assert.throws(()=>parser.stdout(Buffer.from(JSON.stringify(successEvents()[0])+'\n')),{code:'CODEX_PROCESS_FAILED'});
  assert.equal(details.source,'parser'); assert.equal(details.category,'unclassified');
  assert.equal(details.byteLength,Buffer.byteLength('SYNTHETIC_SECRET_PARSER'));
  assert.equal(details.fingerprint.length,64);
  assert.doesNotMatch(JSON.stringify(details),/SYNTHETIC_SECRET/);
});

void test('Codex rust-v0.153.4 complete official usage accepts the validated success stream', () => {
  const p = outputParser(brief);
  for (const event of [
    { type: 'thread.started', thread_id: 'synthetic-01534' },
    { type: 'turn.started' },
    {
      type: 'item.completed',
      item: {
        id: 'answer',
        type: 'agent_message',
        text: JSON.stringify(proposal()),
      },
    },
    { type: 'turn.completed', usage: officialUsage },
  ])
    p.stdout(Buffer.from(JSON.stringify(event) + '\n'));
  const result = p.finish({ code: 0, signalCode: null });
  assert.equal(result.proposal.concepts.length, 3);
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 300 });
});
void test('every official counter is required and a safe nonnegative integer; unknown fields stay rejected', () => {
  const invalid = [{ ...officialUsage, future_counter: 0 }];
  for (const key of Object.keys(officialUsage)) {
    const missing = { ...officialUsage };
    delete missing[key];
    invalid.push(missing);
    for (const value of [-1, 0.5, '1', null, true, 9007199254740992])
      invalid.push({ ...officialUsage, [key]: value });
  }
  for (const usage of invalid) {
    const parser = outputParser(brief);
    const events = successEvents();
    events.at(-1).usage = usage;
    assert.throws(
      () => {
        for (const e of events)
          parser.stdout(Buffer.from(JSON.stringify(e) + '\n'));
      },
      { code: 'CODEX_INVALID_OUTPUT' },
    );
  }
});
void test('numerical reasoning/cache usage metadata is separate from discarded reasoning text', () => {
  const observer = createInvocation({
    jobId: 'job_' + '1'.repeat(32),
    attempt: 1,
    runtimeSha256: 'a'.repeat(64),
    inputSha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
    jobSpecSha256: 'd'.repeat(64),
  });
  const parser = outputParser(brief, observer);
  for (const byte of Buffer.from(
    successEvents()
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  ))
    parser.stdout(Buffer.from([byte]));
  parser.finish({ code: 0, signalCode: null });
  const receipt = observer.finish();
  assert.deepEqual(receipt.usage, officialUsage);
  assert.equal(receipt.lastValidEvent, 'turn.completed');
  assert.equal(receipt.terminalSeen, true);
  assert.equal(validInvocation(receipt), true);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /SYNTHETIC_SECRET_REASONING_NEVER_STORE/,
  );
});
