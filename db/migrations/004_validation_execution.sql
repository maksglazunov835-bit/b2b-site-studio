CREATE TABLE agent_execution_grants (
  pairing_id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_id text UNIQUE,
  mode text NOT NULL DEFAULT 'data_validation' CHECK (mode='data_validation'),
  type text NOT NULL DEFAULT 'site_spec_validation' CHECK (type='site_spec_validation'),
  validator_sha256 char(64) NOT NULL CHECK (validator_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id,pairing_id) REFERENCES agent_pairings(workspace_id,id),
  FOREIGN KEY (workspace_id,project_id) REFERENCES projects(workspace_id,id),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id),
  UNIQUE (workspace_id,project_id,agent_id)
);
CREATE FUNCTION protect_execution_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Execution grants are immutable'; END IF;
  IF OLD.agent_id IS NOT NULL OR NEW.agent_id IS NULL OR
    (to_jsonb(NEW)-'agent_id') IS DISTINCT FROM (to_jsonb(OLD)-'agent_id') THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Execution grants are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_grant_guard BEFORE UPDATE OR DELETE ON agent_execution_grants
FOR EACH ROW EXECUTE FUNCTION protect_execution_grant();

ALTER TABLE jobs ADD CONSTRAINT jobs_execution_scope UNIQUE(workspace_id,project_id,id);
ALTER TABLE jobs DROP CONSTRAINT jobs_state_check, DROP CONSTRAINT jobs_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_execution_state CHECK (state IN
  ('queued','claimed','running','validating','cancel_requested','succeeded','failed','cancelled'));
ALTER TABLE jobs ADD CONSTRAINT jobs_cancellation_time CHECK ((state='cancelled')=(cancelled_at IS NOT NULL));

CREATE TABLE job_executions (
  job_id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_id text NOT NULL,
  job_spec jsonb NOT NULL CHECK (jsonb_typeof(job_spec)='object' AND octet_length(job_spec::text)<=98304),
  spec_sha256 char(64) NOT NULL CHECK (spec_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (workspace_id,project_id,job_id) REFERENCES jobs(workspace_id,project_id,id),
  FOREIGN KEY (workspace_id,project_id,agent_id) REFERENCES agent_execution_grants(workspace_id,project_id,agent_id),
  UNIQUE (workspace_id,project_id,job_id,agent_id)
);
CREATE TRIGGER job_executions_immutable BEFORE UPDATE OR DELETE ON job_executions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE TABLE job_attempts (
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  agent_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('claimed','running','validating','cancel_requested','succeeded','failed','cancelled','expired')),
  claim_key_sha256 char(64) NOT NULL CHECK (claim_key_sha256 ~ '^[a-f0-9]{64}$'),
  lease_sha256 char(64) NOT NULL CHECK (lease_sha256 ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  failure_code text CHECK (failure_code IN ('LEASE_EXPIRED','STOP_UNCONFIRMED','ATTEMPTS_EXHAUSTED','VALIDATOR_FAILED','INPUT_REJECTED','REPORT_REJECTED','RUNNER_STOPPED')),
  PRIMARY KEY(job_id,attempt),
  UNIQUE(agent_id,claim_key_sha256),
  FOREIGN KEY(workspace_id,project_id,job_id,agent_id) REFERENCES job_executions(workspace_id,project_id,job_id,agent_id),
  CHECK(deadline_at=claimed_at+interval '30 seconds' AND expires_at>claimed_at AND expires_at<=deadline_at),
  CHECK ((state IN ('succeeded','failed','cancelled','expired'))=(finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX active_job_attempt ON job_attempts(job_id) WHERE finished_at IS NULL;
CREATE UNIQUE INDEX active_agent_slot ON job_attempts(agent_id) WHERE finished_at IS NULL;
CREATE INDEX execution_lease_expiry ON job_attempts(workspace_id,expires_at) WHERE finished_at IS NULL;
CREATE FUNCTION protect_job_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Attempt history is immutable'; END IF;
  IF OLD.finished_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['state','expires_at','finished_at','failure_code']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','expires_at','finished_at','failure_code']) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Attempt fencing and terminal state are immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER job_attempt_guard BEFORE UPDATE OR DELETE ON job_attempts
FOR EACH ROW EXECUTE FUNCTION protect_job_attempt();

CREATE TABLE job_results (
  job_id text PRIMARY KEY,
  attempt integer NOT NULL,
  result_digest char(64) NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object' AND octet_length(report::text)<=32768),
  created_at timestamptz NOT NULL,
  FOREIGN KEY(job_id,attempt) REFERENCES job_attempts(job_id,attempt)
);
CREATE TRIGGER job_results_immutable BEFORE UPDATE OR DELETE ON job_results
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE TABLE execution_operations (
  job_id text NOT NULL,
  attempt integer NOT NULL,
  operation text NOT NULL CHECK(operation IN ('start','result','fail','cancel-ack')),
  key_sha256 char(64) NOT NULL CHECK(key_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 char(64) NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object' AND octet_length(response::text)<=1024),
  PRIMARY KEY(job_id,attempt,operation,key_sha256),
  FOREIGN KEY(job_id,attempt) REFERENCES job_attempts(job_id,attempt)
);
CREATE TRIGGER execution_operations_immutable BEFORE UPDATE OR DELETE ON execution_operations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

ALTER TABLE job_events DROP CONSTRAINT job_events_check, DROP CONSTRAINT job_events_actor_type_check, DROP CONSTRAINT job_events_source_check;
ALTER TABLE job_events ADD CONSTRAINT execution_event_actor CHECK(actor_type IN ('operator','agent','system'));
ALTER TABLE job_events ADD CONSTRAINT execution_event_source CHECK(source IN ('local_ui','local_runner','lease_sweep'));
ALTER TABLE job_events ADD CONSTRAINT execution_event_transition CHECK (
  (sequence=1 AND event_type='job_queued' AND from_state IS NULL AND to_state='queued') OR
  (sequence>1 AND (
    (event_type='job_dispatched' AND from_state='queued' AND to_state='queued') OR
    (event_type='job_claimed' AND from_state='queued' AND to_state='claimed') OR
    (event_type='job_started' AND from_state='claimed' AND to_state='running') OR
    (event_type='job_validating' AND from_state='running' AND to_state='validating') OR
    (event_type='job_succeeded' AND from_state='validating' AND to_state='succeeded') OR
    (event_type='job_cancel_requested' AND from_state IN ('claimed','running','validating') AND to_state='cancel_requested') OR
    (event_type='job_cancelled' AND from_state IN ('queued','cancel_requested') AND to_state='cancelled') OR
    (event_type='job_lease_expired' AND from_state IN ('claimed','running','validating') AND to_state='queued') OR
    (event_type='job_failed' AND from_state IN ('claimed','running','validating','cancel_requested') AND to_state='failed')
  ))
);

CREATE OR REPLACE FUNCTION protect_job_source_and_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Jobs cannot be deleted'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','version','updated_at','cancelled_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','version','updated_at','cancelled_at']) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Job input is immutable';
  END IF;
  IF OLD.state IN ('succeeded','failed','cancelled') OR NEW.version<>OLD.version+1 OR NOT (
    (OLD.state='queued' AND NEW.state IN ('queued','claimed','cancelled')) OR
    (OLD.state='claimed' AND NEW.state IN ('running','cancel_requested','queued','failed')) OR
    (OLD.state='running' AND NEW.state IN ('validating','cancel_requested','queued','failed')) OR
    (OLD.state='validating' AND NEW.state IN ('succeeded','cancel_requested','queued','failed')) OR
    (OLD.state='cancel_requested' AND NEW.state IN ('cancelled','failed'))
  ) THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Invalid job transition'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION check_job_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id text; target jobs%ROWTYPE; event_count integer; latest job_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='jobs' THEN target_id:=NEW.id; ELSE target_id:=NEW.job_id; END IF;
  SELECT * INTO target FROM jobs WHERE id=target_id;
  SELECT count(*) INTO event_count FROM job_events WHERE job_id=target_id;
  SELECT * INTO latest FROM job_events WHERE job_id=target_id ORDER BY sequence DESC LIMIT 1;
  IF event_count<>target.version OR latest.sequence<>target.version OR latest.to_state<>target.state OR
    EXISTS (SELECT 1 FROM job_events e LEFT JOIN job_events p ON p.job_id=e.job_id AND p.sequence=e.sequence-1
      WHERE e.job_id=target_id AND e.sequence>1 AND (p.sequence IS NULL OR p.to_state IS DISTINCT FROM e.from_state)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Job journal is incomplete';
  END IF;
  IF target.state IN ('claimed','running','validating','cancel_requested') AND NOT EXISTS
    (SELECT 1 FROM job_attempts WHERE job_id=target_id AND state=target.state AND finished_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Active job requires matching attempt';
  END IF;
  IF target.state='succeeded' AND NOT EXISTS
    (SELECT 1 FROM job_results r JOIN job_attempts a USING(job_id,attempt) WHERE r.job_id=target_id AND a.state='succeeded') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Success requires immutable validated result';
  END IF;
  IF target.state<>'succeeded' AND EXISTS(SELECT 1 FROM job_results WHERE job_id=target_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Result requires success';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER execution_result_consistent AFTER INSERT ON job_results
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_job_journal();
CREATE CONSTRAINT TRIGGER execution_attempt_consistent AFTER INSERT OR UPDATE ON job_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_job_journal();
