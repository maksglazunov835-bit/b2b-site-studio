CREATE TABLE agents (
  id text PRIMARY KEY CHECK (id ~ '^agent_[a-f0-9]{32}$'),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_name text NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 64),
  agent_version text NOT NULL CHECK (length(agent_version) BETWEEN 1 AND 32),
  os text NOT NULL CHECK (os IN ('windows','linux','macos')),
  mode text NOT NULL DEFAULT 'presence_only' CHECK (mode = 'presence_only'),
  api_version text NOT NULL CHECK (api_version = 'v1'),
  credential_sha256 char(64) NOT NULL UNIQUE CHECK (credential_sha256 ~ '^[a-f0-9]{64}$'),
  heartbeat_interval_seconds integer NOT NULL CHECK (heartbeat_interval_seconds BETWEEN 1 AND 30),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','revoked')),
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (workspace_id,id),
  CHECK ((status = 'registered' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX agents_workspace_created_idx ON agents(workspace_id,created_at DESC,id DESC);

CREATE TABLE agent_pairings (
  id text PRIMARY KEY CHECK (id ~ '^pairing_[a-f0-9]{32}$'),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  secret_sha256 char(64) NOT NULL UNIQUE CHECK (secret_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = created_at + interval '5 minutes'),
  consumed_at timestamptz,
  revoked_at timestamptz,
  agent_id text,
  registration_key_sha256 char(64),
  registration_sha256 char(64),
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id) ON DELETE RESTRICT,
  CHECK ((consumed_at IS NULL AND agent_id IS NULL AND registration_key_sha256 IS NULL AND registration_sha256 IS NULL)
    OR (consumed_at IS NOT NULL AND revoked_at IS NULL AND agent_id IS NOT NULL AND
      registration_key_sha256 IS NOT NULL AND registration_sha256 IS NOT NULL)),
  CHECK (registration_key_sha256 IS NULL OR registration_key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (registration_sha256 IS NULL OR registration_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX agent_pairings_workspace_idx ON agent_pairings(workspace_id,expires_at);

CREATE TABLE agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id text,
  pairing_id text,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (payload = '{}'::jsonb),
  FOREIGN KEY (workspace_id,agent_id) REFERENCES agents(workspace_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id,pairing_id) REFERENCES agent_pairings(workspace_id,id) ON DELETE RESTRICT,
  CHECK ((event_type IN ('paired','pairing_revoked') AND pairing_id IS NOT NULL AND agent_id IS NULL)
    OR (event_type = 'registered' AND pairing_id IS NOT NULL AND agent_id IS NOT NULL)
    OR (event_type = 'agent_revoked' AND pairing_id IS NULL AND agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX agent_event_pairing_once ON agent_events(pairing_id,event_type) WHERE pairing_id IS NOT NULL;
CREATE UNIQUE INDEX agent_event_agent_once ON agent_events(agent_id,event_type) WHERE agent_id IS NOT NULL;
CREATE TRIGGER agent_events_append_only BEFORE UPDATE OR DELETE ON agent_events
FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_mutation();

CREATE FUNCTION protect_agent_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Agent history cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','last_seen_at','revoked_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','last_seen_at','revoked_at']) OR OLD.status = 'revoked' OR
     (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at < OLD.last_seen_at)) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Agent identity or revocation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agents_identity_guard BEFORE UPDATE OR DELETE ON agents
FOR EACH ROW EXECUTE FUNCTION protect_agent_connection();

CREATE FUNCTION protect_agent_pairing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Pairing history cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['consumed_at','revoked_at','agent_id','registration_key_sha256','registration_sha256']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['consumed_at','revoked_at','agent_id','registration_key_sha256','registration_sha256']) OR
     OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Pairing binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_pairings_identity_guard BEFORE UPDATE OR DELETE ON agent_pairings
FOR EACH ROW EXECUTE FUNCTION protect_agent_pairing();
