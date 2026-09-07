import http from "node:http";
import { parseBounded } from "../server/execution/bounds.mjs";

export class RunnerError extends Error {
  constructor(code, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}
export function localOrigin(value) {
  const match = typeof value === "string" && /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw new RunnerError("LOCAL_ORIGIN_REQUIRED");
  return value.replace(/\/$/, "");
}

export async function post(origin, path, secret, body, { key, signal, timeoutMs = 5000 } = {}) {
  origin = localOrigin(origin);
  if (!/^\/api\/v1\/agents\/(register|agent_[a-f0-9]{32}\/(health|claim|jobs\/job_[a-f0-9]{32}\/(start|heartbeat|result|fail|cancel-ack)))$/.test(path)) throw new RunnerError("INVALID_ENDPOINT");
  if (Buffer.byteLength(body) > (path.endsWith('/result') ? 17408 : 4096)) throw new RunnerError("REQUEST_TOO_LARGE");
  const responseLimit = path.endsWith('/claim') ? 81920 : 16384;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000) throw new RunnerError("INVALID_TIMEOUT");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let finished = false; let timedOut = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const request = http.request(new URL(path, origin), { method: "POST", agent: false, signal,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${secret}`, ...(key ? { "Idempotency-Key": key } : {}) }
    }, (response) => {
      const refuse = (code) => { finish(new RunnerError(code)); response.destroy(); request.destroy(); };
      if (response.statusCode >= 300 && response.statusCode < 400) return refuse("REDIRECT_REFUSED");
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) return refuse("INVALID_RESPONSE");
      if (Number(response.headers["content-length"]) > responseLimit) return refuse("RESPONSE_TOO_LARGE");
      let size = 0; const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > responseLimit) return refuse("RESPONSE_TOO_LARGE");
        chunks.push(chunk);
      });
      response.on("error", () => finish(new RunnerError("NETWORK_UNAVAILABLE", true)));
      response.on("end", () => {
        try { finish(null, { status: response.statusCode, body: parseBounded(Buffer.concat(chunks).toString("utf8"), responseLimit) }); }
        catch { finish(new RunnerError("INVALID_RESPONSE")); }
      });
    });
    request.on("error", () => finish(signal?.aborted ? signal.reason : new RunnerError(timedOut ? "REQUEST_TIMEOUT" : "NETWORK_UNAVAILABLE", true)));
    const timer = setTimeout(() => { timedOut = true; request.destroy(); }, timeoutMs);
    request.end(body);
  });
}
