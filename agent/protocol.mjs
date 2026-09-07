import { RunnerError } from "./transport.mjs";
import { compatible } from "../server/execution/contract.mjs";

const profileKeys = ["mode","selectedApiVersion","executionEnabled","freeSlots","currentJobId","grantedCapabilities","agentId","heartbeatIntervalSeconds"];
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key)); }
export function reply(result, kind, expectedId, mode = "presence_only") {
  if (result.status !== (kind === "register" ? 201 : 200)) {
    const error = result.body?.error;
    if (!keys(result.body, ["error"]) || !keys(error, ["code","message","details"]) || typeof error.message !== "string" || !object(error.details)) throw new RunnerError("INVALID_RESPONSE");
    const terminal = ["UNAUTHORIZED_AGENT","AGENT_REVOKED","PAIRING_EXPIRED","PAIRING_REVOKED","PAIRING_CONSUMED","INCOMPATIBLE_PROTOCOL_VERSION","PERSISTENCE_DISABLED","VALIDATION_FAILED","VALIDATOR_MISMATCH","EXECUTION_SCOPE_MISMATCH"];
    if (terminal.includes(error.code)) throw new RunnerError(error.code);
    if ([429,500,502,503,504].includes(result.status)) throw new RunnerError("PLATFORM_UNAVAILABLE", true);
    throw new RunnerError("REQUEST_REJECTED");
  }
  const body = result.body;
  const data = mode === "data_validation";
  if (!keys(body, [...profileKeys, ...(data ? ["projectId","validator"] : []), ...(kind === "register" ? ["status"] : ["accepted","serverTime"])]) ||
      body.mode !== mode || body.executionEnabled !== data ||
      (data ? ![0,1].includes(body.freeSlots) || (body.currentJobId !== null && !/^job_[a-f0-9]{32}$/.test(body.currentJobId)) : body.freeSlots !== 0 || body.currentJobId !== null) ||
      !Array.isArray(body.grantedCapabilities) || JSON.stringify(body.grantedCapabilities) !== JSON.stringify(data ? ["validate_site_spec"] : []) ||
      typeof body.agentId !== "string" || !/^agent_[a-f0-9]{32}$/.test(body.agentId) || (expectedId && body.agentId !== expectedId) ||
      !Number.isInteger(body.heartbeatIntervalSeconds) || body.heartbeatIntervalSeconds < 1 || body.heartbeatIntervalSeconds > 30) throw new RunnerError("INVALID_RESPONSE");
  if (data && (typeof body.projectId !== "string" || !/^[a-f0-9-]{36}$/.test(body.projectId) || !compatible(body.validator))) throw new RunnerError("VALIDATOR_MISMATCH");
  if (body.selectedApiVersion !== "v1") throw new RunnerError("INCOMPATIBLE_PROTOCOL_VERSION");
  if (kind === "register" ? body.status !== "registered" : body.accepted !== true || typeof body.serverTime !== "string" || !Number.isFinite(Date.parse(body.serverTime)) || new Date(body.serverTime).toISOString() !== body.serverTime) throw new RunnerError("INVALID_RESPONSE");
  return body;
}
