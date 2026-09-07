import { parseBounded } from "./bounds.mjs";
import { executionError } from "./transitions.mjs";
export async function executionBody(request, kind) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) executionError("VALIDATION_FAILED", 415);
  const limit = kind === "result" ? 17408 : 2048;
  if (Number(request.headers.get("content-length")) > limit) executionError("JSON_BYTES_LIMIT", 413);
  if (!request.body) executionError("INVALID_JSON_VALUE", 400);
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) { await reader.cancel(); executionError("JSON_BYTES_LIMIT", 413); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  try { return parseBounded(Buffer.concat(chunks).toString("utf8"), limit); }
  catch (error) {
    if (error.code === "INVALID_JSON_VALUE") executionError(error.code, 400);
    if (error.code === "JSON_BYTES_LIMIT") executionError(error.code, 413);
    throw error;
  }
}
