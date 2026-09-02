import { asPersistenceError, PersistenceError } from "../persistence/errors.mjs";

export const JSON_BODY_LIMIT_BYTES = 64 * 1024;

async function readLimitedText(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > JSON_BODY_LIMIT_BYTES) {
        throw new PersistenceError("PAYLOAD_TOO_LARGE", "The JSON request body is too large.", {
          status: 413,
          details: { maxBytes: JSON_BODY_LIMIT_BYTES }
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

export async function parseJsonBody(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new PersistenceError("VALIDATION_FAILED", "Content-Type must be application/json.", {
      status: 415,
      details: { header: "Content-Type" }
    });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > JSON_BODY_LIMIT_BYTES) {
    throw new PersistenceError("PAYLOAD_TOO_LARGE", "The JSON request body is too large.", {
      status: 413,
      details: { maxBytes: JSON_BODY_LIMIT_BYTES }
    });
  }
  const text = await readLimitedText(request);
  try {
    return JSON.parse(text);
  } catch {
    throw new PersistenceError("INVALID_JSON", "The request body is not valid JSON.", { status: 400 });
  }
}

export function idempotencyKey(request) {
  return request.headers.get("idempotency-key");
}

export async function handleApi(action, defaultStatus = 200) {
  try {
    const result = await action();
    if (result && typeof result === "object" && Object.hasOwn(result, "responseStatus")) {
      const headers = result.replayed ? { "Idempotency-Replayed": "true" } : {};
      return json(result.response, result.responseStatus, headers);
    }
    return json(result, defaultStatus);
  } catch (error) {
    const publicError = asPersistenceError(error);
    if (publicError.code === "INTERNAL_ERROR") {
      const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
      console.error(`[api] unhandled request error (${code})`);
    }
    return json(
      {
        error: {
          code: publicError.code,
          message: publicError.message,
          details: publicError.details ?? {}
        }
      },
      publicError.status
    );
  }
}
