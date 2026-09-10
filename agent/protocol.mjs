import { RunnerError } from "./transport.mjs";
import { compatible } from "../server/execution/contract.mjs";
import { assertRuntime, adapterCompatible, runtimeExecutable } from '../server/design/contract.mjs';

const profileKeys = ["mode","selectedApiVersion","executionEnabled","freeSlots","currentJobId","grantedCapabilities","agentId","heartbeatIntervalSeconds"];
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key)); }
export function reply(result, kind, expectedId, mode = "presence_only") {
  if (result.status !== (kind === "register" ? 201 : 200)) {
    const error = result.body?.error;
    if (!keys(result.body, ["error"]) || !keys(error, ["code","message","details"]) || typeof error.message !== "string" || !object(error.details)) throw new RunnerError("INVALID_RESPONSE");
    const terminal = ["UNAUTHORIZED_AGENT","AGENT_REVOKED","PAIRING_EXPIRED","PAIRING_REVOKED","PAIRING_CONSUMED","INCOMPATIBLE_PROTOCOL_VERSION","PERSISTENCE_DISABLED","VALIDATION_FAILED","VALIDATOR_MISMATCH","EXECUTION_SCOPE_MISMATCH","INVALID_CODEX_RUNTIME","TEST_PROVIDER_DISABLED"];
    const failure = new RunnerError(terminal.includes(error.code) ? error.code : [429,500,502,503,504].includes(result.status) ? 'PLATFORM_UNAVAILABLE' : 'REQUEST_REJECTED', [429,500,502,503,504].includes(result.status));
    failure.httpStatus=result.status;
    failure.httpErrorCode=terminal.includes(error.code) ? error.code : null;
    throw failure;
  }
  const body = result.body;
  const data = mode === "data_validation";
  const design = mode === 'codex_design';
  if (design) { assertRuntime(body?.runtime); if (!adapterCompatible(body?.adapter)) throw new RunnerError('INVALID_RESPONSE'); }
  const enabled = data || (design && runtimeExecutable(body.runtime,{allowTest:true}));
  if (!keys(body, [...profileKeys, ...(data ? ["projectId","validator"] : design ? ['projectId','adapter','runtime'] : []), ...(kind === "register" ? ["status"] : ["accepted","serverTime"])]) ||
      body.mode !== mode || body.executionEnabled !== enabled ||
      (enabled ? ![0,1].includes(body.freeSlots) || (body.currentJobId !== null && !/^job_[a-f0-9]{32}$/.test(body.currentJobId)) : body.freeSlots !== 0 || body.currentJobId !== null) ||
      !Array.isArray(body.grantedCapabilities) || JSON.stringify(body.grantedCapabilities) !== JSON.stringify(data ? ["validate_site_spec"] : enabled ? ['codex-design'] : []) ||
      typeof body.agentId !== "string" || !/^agent_[a-f0-9]{32}$/.test(body.agentId) || (expectedId && body.agentId !== expectedId) ||
      !Number.isInteger(body.heartbeatIntervalSeconds) || body.heartbeatIntervalSeconds < 1 || body.heartbeatIntervalSeconds > 30) throw new RunnerError("INVALID_RESPONSE");
  if (data && (typeof body.projectId !== "string" || !/^[a-f0-9-]{36}$/.test(body.projectId) || !compatible(body.validator))) throw new RunnerError("VALIDATOR_MISMATCH");
  if (design && !/^[a-f0-9-]{36}$/.test(body.projectId)) throw new RunnerError('INVALID_RESPONSE');
  if (body.selectedApiVersion !== "v1") throw new RunnerError("INCOMPATIBLE_PROTOCOL_VERSION");
  if (kind === "register" ? body.status !== "registered" : body.accepted !== true || typeof body.serverTime !== "string" || !Number.isFinite(Date.parse(body.serverTime)) || new Date(body.serverTime).toISOString() !== body.serverTime) throw new RunnerError("INVALID_RESPONSE");
  return body;
}
