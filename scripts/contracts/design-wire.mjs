// Deterministic provider projection. The original schema and semantic validator
// remain authoritative; generation-time structure is not server acceptance.
const omitted = new Set([
  '$schema',
  '$id',
  'title',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
]);
const permitted = new Set([
  'type',
  'additionalProperties',
  'required',
  'properties',
  'items',
  'enum',
  'const',
]);
export function designWireSchema(source) {
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  let count = 0;
  let enumCount = 0;
  function visit(node, depth) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 10)
      throw Error('WIRE_SCHEMA_INVALID');
    for (const key of Object.keys(node))
      if (!omitted.has(key) && !permitted.has(key))
        throw Error('WIRE_SCHEMA_UNKNOWN_KEYWORD');
    const values =
      node.enum ?? (Object.hasOwn(node, 'const') ? [node.const] : undefined);
    const type =
      node.type ??
      (values?.every((v) => typeof v === 'string')
        ? 'string'
        : values?.every(Number.isInteger)
          ? 'integer'
          : null);
    if (
      !['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(
        type,
      )
    )
      throw Error('WIRE_SCHEMA_MISSING_TYPE');
    const result = { type };
    if (values) {
      enumCount += values.length;
      if (
        !values.length ||
        enumCount > 1000 ||
        (values.length > 250 && JSON.stringify(values).length > 15000)
      )
        throw Error('WIRE_SCHEMA_ENUM_LIMIT');
      result.enum = [...values];
    }
    if (type === 'object') {
      if (
        node.additionalProperties !== false ||
        !node.properties ||
        [...(node.required ?? [])].sort(compare).join() !==
          Object.keys(node.properties).sort(compare).join()
      )
        throw Error('WIRE_SCHEMA_REQUIRED');
      result.additionalProperties = false;
      result.required = [...node.required];
      count += result.required.length;
      if (count > 5000) throw Error('WIRE_SCHEMA_LIMIT');
      result.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, value]) => [
          key,
          visit(value, depth + 1),
        ]),
      );
    }
    if (type === 'array') result.items = visit(node.items, depth + 1);
    return result;
  }
  const result = visit(source, 1);
  if (result.type !== 'object' || JSON.stringify(result).length > 120000)
    throw Error('WIRE_SCHEMA_ROOT');
  return result;
}
