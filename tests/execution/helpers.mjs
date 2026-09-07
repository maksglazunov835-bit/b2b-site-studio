import { randomUUID } from "node:crypto";
import { createProject } from "../../server/persistence/service.mjs";
import { jobs } from "../../server/jobs/service.mjs";
import { createAgentService } from "../../server/agents/service.mjs";
import { createExecutionService } from "../../server/execution/service.mjs";
import { newSecret } from "../../server/agents/requests.mjs";
import { VALIDATOR } from "../../server/execution/contract.mjs";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
export async function fixture({ projectId, revision = 1, dispatch = true, presence = false } = {}) {
  assertSafeTestDatabaseUrl();
  const time = { now: Date.now() }; const clock = () => new Date(time.now);
  const agents = createAgentService({ clock }); const execution = createExecutionService({ clock });
  projectId ??= (await createProject({ displayName: "Execution fixture", draft: {} }, randomUUID())).response.project.id;
  const job = (await jobs.create(projectId, { type: "site_spec_validation", expectedRevision: revision }, randomUUID())).response.job;
  const pairing = await agents.pair(presence ? {} : { mode: "data_validation", projectId });
  const credential = newSecret("agt");
  const registration = await agents.register(pairing.pairingSecret, { mode: presence ? "presence_only" : "data_validation", agentName: "Execution test Runner",
    agentVersion: "0.3.1", os: "linux", supportedApiVersions: ["v1"], agentSecret: credential, ...(presence ? {} : { validator: VALIDATOR }) }, randomUUID());
  const agentId = registration.response.agentId;
  if (dispatch) await execution.dispatch(projectId, job.id, { agentId, expectedVersion: 1 }, randomUUID());
  return { time, clock, agents, execution, projectId, jobId: job.id, agentId, credential, pairing,
    claim: (key = randomUUID()) => execution.claim(agentId, credential, {}, key),
    action: (assignment, kind, extra = {}, key = randomUUID()) => execution.action(agentId, job.id, credential, kind,
      { attempt: assignment.attempt, leaseToken: assignment.leaseToken, ...extra }, key) };
}
