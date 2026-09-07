-- Extend shared execution records without rewriting saved inputs or history.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check, DROP CONSTRAINT jobs_template_version_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_typed_template CHECK
 ((type='site_spec_validation' AND template_version='site_spec_validation@1') OR (type='design_proposal' AND template_version='design_proposal@1'));
ALTER TABLE agent_execution_grants DROP CONSTRAINT agent_execution_grants_mode_check, DROP CONSTRAINT agent_execution_grants_type_check;
ALTER TABLE agent_execution_grants ADD CONSTRAINT grants_typed_mode CHECK
 ((mode='data_validation' AND type='site_spec_validation') OR (mode='codex_design' AND type='design_proposal'));
CREATE TABLE design_agent_profiles (
 pairing_id text PRIMARY KEY REFERENCES agent_execution_grants(pairing_id),
 runtime jsonb NOT NULL CHECK(jsonb_typeof(runtime)='object' AND octet_length(runtime::text)<=1024)
);
CREATE TRIGGER design_profile_immutable BEFORE UPDATE OR DELETE ON design_agent_profiles
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
ALTER TABLE job_attempts DROP CONSTRAINT job_attempts_check;
ALTER TABLE job_attempts ADD CONSTRAINT attempt_lease_bounds CHECK(expires_at>claimed_at AND expires_at<=deadline_at);
ALTER TABLE job_attempts DROP CONSTRAINT job_attempts_failure_code_check;
ALTER TABLE job_attempts ADD CONSTRAINT attempt_failure_code CHECK(failure_code IN
 ('LEASE_EXPIRED','STOP_UNCONFIRMED','ATTEMPTS_EXHAUSTED','VALIDATOR_FAILED','INPUT_REJECTED','REPORT_REJECTED','RUNNER_STOPPED',
 'INVOCATION_UNCERTAIN','CODEX_NOT_AVAILABLE','CODEX_UNSUPPORTED_VERSION','CODEX_LOGIN_REQUIRED','CODEX_AUTH_UNSUPPORTED',
 'CODEX_SAFE_PROFILE_UNVERIFIED','CODEX_QUOTA','CODEX_TIMEOUT','CODEX_INVALID_OUTPUT','CODEX_OUTPUT_LIMIT','CODEX_PROCESS_FAILED'));
CREATE FUNCTION check_typed_attempt_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_type text;
BEGIN
 SELECT type INTO job_type FROM jobs WHERE id=NEW.job_id;
 IF (job_type='design_proposal' AND (NEW.attempt<>1 OR NEW.deadline_at<>NEW.claimed_at+interval '180 seconds')) OR
    (job_type='site_spec_validation' AND NEW.deadline_at<>NEW.claimed_at+interval '30 seconds') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Execution policy mismatch';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER attempt_typed_policy BEFORE INSERT OR UPDATE ON job_attempts
FOR EACH ROW EXECUTE FUNCTION check_typed_attempt_policy();
-- Consumed before process spawn, never replayed as a second invocation permit.
CREATE TABLE design_invocations (
 job_id text PRIMARY KEY,
 attempt integer NOT NULL CHECK(attempt=1),
 consumed_at timestamptz NOT NULL,
 FOREIGN KEY(job_id,attempt) REFERENCES job_attempts(job_id,attempt)
);
CREATE TRIGGER design_invocation_immutable BEFORE UPDATE OR DELETE ON design_invocations
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
