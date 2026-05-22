-- adminsearch — schema inicial
-- Gerado manualmente alinhado com src/server/db/schema.ts.
-- Aplicado pelo migrate.ts no boot do servidor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS machines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dns_host_name    text NOT NULL,
  net_bios_name    text NOT NULL,
  domain           text,
  bios_serial      text,
  chassis_uuid     text,
  primary_mac      text,
  os_caption       text,
  os_version       text,
  os_build         text,
  last_boot_at     timestamptz,
  last_logged_user text,
  ip_addresses     text[],
  agent_version    text,
  tags             text[] NOT NULL DEFAULT '{}',
  notes            text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS machines_fqdn_unique ON machines (dns_host_name);
CREATE INDEX IF NOT EXISTS machines_bios_serial_idx ON machines (bios_serial);
CREATE INDEX IF NOT EXISTS machines_chassis_uuid_idx ON machines (chassis_uuid);
CREATE INDEX IF NOT EXISTS machines_last_seen_idx ON machines (last_seen_at);

CREATE TABLE IF NOT EXISTS scan_runs (
  id                     uuid PRIMARY KEY,
  machine_id             uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  collected_at           timestamptz NOT NULL,
  received_at            timestamptz NOT NULL DEFAULT now(),
  source                 text NOT NULL,
  agent_version          text,
  total_raw_members      integer NOT NULL DEFAULT 0,
  raw_payload            jsonb NOT NULL,
  expansion_status       text NOT NULL DEFAULT 'pending',
  expansion_error        text,
  expansion_started_at   timestamptz,
  expansion_finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS scan_runs_machine_collected_idx ON scan_runs (machine_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS scan_runs_expansion_pending_idx ON scan_runs (expansion_status);

CREATE TABLE IF NOT EXISTS raw_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id  uuid NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  sid          text NOT NULL,
  name         text,
  object_class text NOT NULL,
  resolved     boolean NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_members_scan_idx ON raw_members (scan_run_id);

CREATE TABLE IF NOT EXISTS ad_users (
  sid                  text PRIMARY KEY,
  sam_account_name     text,
  user_principal_name  text,
  display_name         text,
  email                text,
  department           text,
  title                text,
  manager_dn           text,
  distinguished_name   text,
  enabled              boolean,
  password_last_set    timestamptz,
  last_logon           timestamptz,
  account_expires      timestamptz,
  is_service_account   boolean NOT NULL DEFAULT false,
  last_synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_users_sam_idx ON ad_users (sam_account_name);
CREATE INDEX IF NOT EXISTS ad_users_enabled_idx ON ad_users (enabled);

CREATE TABLE IF NOT EXISTS effective_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id           uuid NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  machine_id            uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  sid                   text NOT NULL,
  name                  text,
  source                text NOT NULL,
  via_group             text,
  via_group_sid         text,
  ad_enabled            boolean,
  is_service_account    boolean NOT NULL DEFAULT false,
  severity              text NOT NULL,
  matched_exception_id  uuid
);

CREATE INDEX IF NOT EXISTS effective_members_scan_idx ON effective_members (scan_run_id);
CREATE INDEX IF NOT EXISTS effective_members_machine_idx ON effective_members (machine_id, source);
CREATE INDEX IF NOT EXISTS effective_members_sid_idx ON effective_members (sid);
CREATE INDEX IF NOT EXISTS effective_members_severity_idx ON effective_members (severity);

CREATE TABLE IF NOT EXISTS findings_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id   uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  scan_run_id  uuid REFERENCES scan_runs(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL,
  sid          text,
  name         text,
  details      jsonb
);

CREATE INDEX IF NOT EXISTS findings_events_machine_occurred_idx ON findings_events (machine_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS findings_events_kind_occurred_idx ON findings_events (kind, occurred_at DESC);

CREATE TABLE IF NOT EXISTS exceptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL,
  scope_value  text,
  match_kind   text NOT NULL,
  match_value  text NOT NULL,
  reason       text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);

CREATE INDEX IF NOT EXISTS exceptions_scope_idx ON exceptions (scope, scope_value);
CREATE INDEX IF NOT EXISTS exceptions_match_idx ON exceptions (match_kind, match_value);

CREATE TABLE IF NOT EXISTS admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS admins_username_unique ON admins (username);

CREATE TABLE IF NOT EXISTS audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        text,
  action       text NOT NULL,
  details      jsonb,
  ip           text,
  user_agent   text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_actor_occurred_idx ON audit_log (actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_occurred_idx ON audit_log (action, occurred_at DESC);
