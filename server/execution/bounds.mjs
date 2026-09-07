import { PersistenceError } from "../persistence/errors.mjs";
export const LIMITS = Object.freeze({ snapshot: 65536, envelope: 81920, report: 16384, depth: 32, nodes: 6000 });
export class ExecutionError extends PersistenceError {
  constructor(code) { super(code, "The data validation envelope was rejected.", { status: 422 }); }
}
export function boundedJson(value, maxBytes = LIMITS.envelope) {
  const stack = [[value, 0]]; const seen = new Set(); let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) throw new ExecutionError("JSON_COMPLEXITY_LIMIT");
    if (item === null || typeof item === "boolean" || typeof item === "string") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || seen.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new ExecutionError("INVALID_JSON_VALUE");
    seen.add(item);
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
    if (stack.length + nodes > LIMITS.nodes) throw new ExecutionError("JSON_COMPLEXITY_LIMIT");
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new ExecutionError("JSON_BYTES_LIMIT");
  return text;
}
export function parseBounded(text, maxBytes = LIMITS.envelope) {
  if (Buffer.byteLength(text) > maxBytes) throw new ExecutionError("JSON_BYTES_LIMIT");
  let value;
  try { value = JSON.parse(text); } catch { throw new ExecutionError("INVALID_JSON_VALUE"); }
  boundedJson(value, maxBytes);
  return value;
}
