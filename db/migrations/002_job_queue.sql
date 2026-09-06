ALTER TABLE projects ADD CONSTRAINT projects_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE site_spec_revisions ADD CONSTRAINT revisions_job_input_unique
  UNIQUE (project_id, id, revision, schema_version, canonical_sha256);

CREATE TABLE jobs (
  id text PRIMARY KEY CHECK (id ~ '^job_[a-f0-9]{32}$'),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  site_spec_revision_id uuid NOT NULL,
  input_revision integer NOT NULL,
  input_schema_version text NOT NULL,
  input_sha256 char(64) NOT NULL,
  type text NOT NULL CHECK (type = 'site_spec_validation'),
  template_version text NOT NULL CHECK (template_version = 'site_spec_validation@1'),
  request_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(request_snapshot) = 'object' AND octet_length(request_snapshot::text) <= 4096
  ),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_type text NOT NULL DEFAULT 'operator' CHECK (actor_type = 'operator'),
  source text NOT NULL DEFAULT 'local_ui' CHECK (source = 'local_ui'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, site_spec_revision_id, input_revision, input_schema_version, input_sha256)
    REFERENCES site_spec_revisions(project_id, id, revision, schema_version, canonical_sha256) ON DELETE RESTRICT,
  CHECK ((state = 'queued' AND version = 1 AND cancelled_at IS NULL) OR
         (state = 'cancelled' AND version = 2 AND cancelled_at IS NOT NULL))
);

CREATE INDEX jobs_project_created_idx ON jobs(workspace_id, project_id, created_at DESC, id DESC);

CREATE TABLE job_events (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1024),
  actor_type text NOT NULL DEFAULT 'operator' CHECK (actor_type = 'operator'),
  source text NOT NULL DEFAULT 'local_ui' CHECK (source = 'local_ui'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, sequence),
  CHECK ((sequence = 1 AND event_type = 'job_queued' AND from_state IS NULL AND to_state = 'queued') OR
         (sequence = 2 AND event_type = 'job_cancelled' AND from_state IS NOT DISTINCT FROM 'queued' AND to_state = 'cancelled'))
);

CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON job_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE FUNCTION protect_job_source_and_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Jobs cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','version','updated_at','cancelled_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','version','updated_at','cancelled_at']) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Job input is immutable';
  END IF;
  IF OLD.state <> 'queued' OR NEW.state <> 'cancelled' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Invalid job transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_source_and_transition BEFORE UPDATE OR DELETE ON jobs
FOR EACH ROW EXECUTE FUNCTION protect_job_source_and_transition();

-- Deferred checks permit atomic job/event insertion, but never a committed gap.
CREATE FUNCTION check_job_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id text; target_state text; event_count integer;
BEGIN
  IF TG_TABLE_NAME = 'jobs' THEN target_id := NEW.id; ELSE target_id := NEW.job_id; END IF;
  SELECT state INTO target_state FROM jobs WHERE id = target_id;
  SELECT count(*) INTO event_count FROM job_events WHERE job_id = target_id;
  IF event_count <> (CASE WHEN target_state = 'queued' THEN 1 ELSE 2 END) OR
     NOT EXISTS (SELECT 1 FROM job_events WHERE job_id = target_id AND sequence = 1) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Job journal is incomplete';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER jobs_journal_consistent AFTER INSERT OR UPDATE ON jobs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_job_journal();
CREATE CONSTRAINT TRIGGER job_events_state_consistent AFTER INSERT ON job_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_job_journal();
