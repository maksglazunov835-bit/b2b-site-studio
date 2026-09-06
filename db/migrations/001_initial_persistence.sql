CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT workspaces_name_not_blank CHECK (length(btrim(name)) > 0)
);

INSERT INTO workspaces (id, slug, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Default workspace')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_revision integer NOT NULL DEFAULT 0,
  optimistic_version bigint NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT projects_workspace_slug_unique UNIQUE (workspace_id, slug),
  CONSTRAINT projects_display_name_not_blank CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT projects_status_allowed CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_current_revision_nonnegative CHECK (current_revision >= 0),
  CONSTRAINT projects_optimistic_version_positive CHECK (optimistic_version > 0),
  CONSTRAINT projects_archive_state_consistent CHECK (
    (status = 'active' AND archived_at IS NULL) OR
    (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX projects_workspace_status_updated_idx
  ON projects (workspace_id, status, updated_at DESC);

CREATE TABLE site_spec_revisions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  schema_version text NOT NULL,
  document_stage text NOT NULL,
  canonical_site_spec jsonb NOT NULL,
  canonical_sha256 char(64) NOT NULL,
  editable_sha256 char(64) NOT NULL,
  idempotency_key text,
  actor_type text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT site_spec_revisions_project_revision_unique UNIQUE (project_id, revision),
  CONSTRAINT site_spec_revisions_positive_revision CHECK (revision > 0),
  CONSTRAINT site_spec_revisions_stage_allowed CHECK (
    document_stage IN ('draft', 'generation_ready', 'publish_ready')
  ),
  CONSTRAINT site_spec_revisions_json_object CHECK (jsonb_typeof(canonical_site_spec) = 'object'),
  CONSTRAINT site_spec_revisions_canonical_sha256_format CHECK (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT site_spec_revisions_editable_sha256_format CHECK (editable_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX site_spec_revisions_idempotency_unique
  ON site_spec_revisions (project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX site_spec_revisions_project_created_idx
  ON site_spec_revisions (project_id, created_at DESC);

CREATE TABLE site_spec_readiness_checks (
  revision_id uuid NOT NULL REFERENCES site_spec_revisions(id) ON DELETE RESTRICT,
  gate text NOT NULL,
  check_id text NOT NULL,
  required boolean NOT NULL,
  status text NOT NULL,
  message text NOT NULL,
  evaluator_version text NOT NULL,
  checked_at timestamptz,
  PRIMARY KEY (revision_id, gate, check_id),
  CONSTRAINT site_spec_readiness_gate_allowed CHECK (gate IN ('generation', 'publish')),
  CONSTRAINT site_spec_readiness_status_allowed CHECK (
    status IN ('missing', 'passed', 'failed', 'not_applicable')
  ),
  CONSTRAINT site_spec_readiness_message_not_blank CHECK (length(btrim(message)) > 0),
  CONSTRAINT site_spec_readiness_evaluator_not_blank CHECK (length(btrim(evaluator_version)) > 0)
);

CREATE INDEX site_spec_readiness_gate_status_idx
  ON site_spec_readiness_checks (gate, status);

CREATE TABLE project_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  revision integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT project_events_revision_positive CHECK (revision IS NULL OR revision > 0),
  CONSTRAINT project_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT project_events_type_not_blank CHECK (length(btrim(event_type)) > 0)
);

CREATE INDEX project_events_project_created_idx
  ON project_events (workspace_id, project_id, created_at DESC, id DESC);

CREATE TABLE api_idempotency_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 char(64) NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT api_idempotency_scope_unique UNIQUE (workspace_id, operation, idempotency_key),
  CONSTRAINT api_idempotency_request_sha256_format CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_idempotency_response_status_valid CHECK (response_status BETWEEN 200 AND 299),
  CONSTRAINT api_idempotency_response_object CHECK (jsonb_typeof(response_body) = 'object')
);

CREATE INDEX api_idempotency_created_idx
  ON api_idempotency_records (workspace_id, created_at DESC);

CREATE FUNCTION reject_immutable_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I rows are immutable', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER site_spec_revisions_immutable
BEFORE UPDATE OR DELETE ON site_spec_revisions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE TRIGGER site_spec_readiness_checks_immutable
BEFORE UPDATE OR DELETE ON site_spec_readiness_checks
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE TRIGGER project_events_append_only
BEFORE UPDATE OR DELETE ON project_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();
