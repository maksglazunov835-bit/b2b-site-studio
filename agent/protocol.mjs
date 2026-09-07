import { RunnerError } from "./transport.mjs";

const profileKeys = ["mode","selectedApiVersion","executionEnabled","freeSlots","currentJobId","grantedCapabilities","agentId","heartbeatIntervalSeconds"];
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key)); }
export function reply(result, kind, expectedId) {
  if (result.status !== (kind === "register" ? 201 : 200)) {
    const error = result.body?.error;
    if (!keys(result.body, ["error"]) || !keys(error, ["code","message","details"]) || typeof error.message !== "string" || !object(error.details)) throw new RunnerError("INVALID_RESPONSE");
    const terminal = ["UNAUTHORIZED_AGENT","AGENT_REVOKED","PAIRING_EXPIRED","PAIRING_REVOKED","PAIRING_CONSUMED","INCOMPATIBLE_PROTOCOL_VERSION","PERSISTENCE_DISABLED","VALIDATION_FAILED"];
    if (terminal.includes(error.code)) throw new RunnerError(error.code);
    if ([429,500,502,503,504].includes(result.status)) throw new RunnerError("PLATFORM_UNAVAILABLE", true);
    throw new RunnerError("REQUEST_REJECTED");
  }
  const body = result.body;
  if (!keys(body, [...profileKeys, ...(kind === "register" ? ["status"] : ["accepted","serverTime"])]) ||
      body.mode !== "presence_only" || body.executionEnabled !== false || body.freeSlots !== 0 || body.currentJobId !== null ||
      !Array.isArray(body.grantedCapabilities) || body.grantedCapabilities.length !== 0 ||
      typeof body.agentId !== "string" || !/^agent_[a-f0-9]{32}$/.test(body.agentId) || (expectedId && body.agentId !== expectedId) ||
      !Number.isInteger(body.heartbeatIntervalSeconds) || body.heartbeatIntervalSeconds < 1 || body.heartbeatIntervalSeconds > 30) throw new RunnerError("INVALID_RESPONSE");
  if (body.selectedApiVersion !== "v1") throw new RunnerError("INCOMPATIBLE_PROTOCOL_VERSION");
  if (kind === "register" ? body.status !== "registered" : body.accepted !== true || typeof body.serverTime !== "string" || !Number.isFinite(Date.parse(body.serverTime)) || new Date(body.serverTime).toISOString() !== body.serverTime) throw new RunnerError("INVALID_RESPONSE");
  return body;
}
