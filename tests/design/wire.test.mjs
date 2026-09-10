import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import source from '../../docs/contracts/design-proposal.schema.json' with { type: 'json' };
import wire from '../../docs/contracts/design-proposal.wire.schema.json' with { type: 'json' };
import { designWireSchema } from '../../scripts/contracts/design-wire.mjs';
import { assertProposal } from '../../server/design/contract.mjs';
import { brief, proposal } from './fixtures.mjs';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
void test('actual generated wire uses only the conservative documented structured-output subset', () => {
  assert.deepEqual(wire, designWireSchema(source));
  const keywords = new Set([
    'type',
    'additionalProperties',
    'required',
    'properties',
    'items',
    'enum',
  ]);
  function visit(node) {
    assert.ok(Object.keys(node).every((k) => keywords.has(k)));
    assert.ok(
      ['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(
        node.type,
      ),
    );
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(
        [...node.required].sort(compare),
        Object.keys(node.properties).sort(compare),
      );
      Object.values(node.properties).forEach(visit);
    }
    if (node.type === 'array') visit(node.items);
  }
  visit(wire);
  const validate = new Ajv({ strict: true }).compile(wire);
  assert.equal(validate(proposal()), true);
  const tooFew = proposal();
  tooFew.concepts.pop();
  assert.equal(
    validate(tooFew),
    true,
    'wire is structure only; server still owns exact counts',
  );
  assert.throws(() => assertProposal(tooFew, brief));
  const unsafe = proposal();
  unsafe.concepts[0].name = '<script>alert(1)</script>';
  assert.equal(validate(unsafe), true);
  assert.throws(() => assertProposal(unsafe, brief));
});
void test('wire generation fails closed on unknown keywords, optional properties and excessive enums', () => {
  assert.throws(
    () => designWireSchema({ ...source, allOf: [] }),
    /UNKNOWN_KEYWORD/,
  );
  assert.throws(
    () => designWireSchema({ ...source, required: [] }),
    /REQUIRED/,
  );
  assert.throws(
    () =>
      designWireSchema({
        type: 'object',
        additionalProperties: false,
        required: ['x'],
        properties: {
          x: {
            type: 'string',
            enum: Array.from({ length: 1001 }, (_, i) => String(i)),
          },
        },
      }),
    /ENUM_LIMIT/,
  );
});
