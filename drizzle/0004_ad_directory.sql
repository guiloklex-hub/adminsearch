-- adminsearch — v0.6.0 — Espelho do AD para tela "AD - Grupos e Usuários"
-- Tabelas populadas por job de sync periódico (a cada 6h) + botão manual.
-- A tabela ad_users já existe (cache do enricher); o sync apenas a amplia
-- via UPSERT — passa de "só admins observados" para "todos os usuários
-- do AD". O cache do enricher continua funcionando normalmente.

CREATE TABLE IF NOT EXISTS ad_groups (
  sid                text PRIMARY KEY,
  distinguished_name text NOT NULL,
  sam_account_name   text,
  cn                 text,
  display_name       text,
  description        text,
  group_type         integer,        -- bitmask groupType do AD
  is_security        boolean,        -- derivado de group_type
  scope              text,           -- 'global' | 'domain_local' | 'universal' | 'builtin'
  member_count       integer NOT NULL DEFAULT 0,  -- transitivo, denormalizado
  last_synced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ad_groups_sam_idx     ON ad_groups (sam_account_name);
CREATE INDEX IF NOT EXISTS ad_groups_display_idx ON ad_groups (display_name);

CREATE TABLE IF NOT EXISTS ad_group_memberships (
  user_sid   text NOT NULL,
  group_sid  text NOT NULL,
  is_direct  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_sid, group_sid)
);
CREATE INDEX IF NOT EXISTS ad_group_memberships_user_idx  ON ad_group_memberships (user_sid);
CREATE INDEX IF NOT EXISTS ad_group_memberships_group_idx ON ad_group_memberships (group_sid);

CREATE TABLE IF NOT EXISTS ad_directory_syncs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL,         -- 'running' | 'success' | 'failed'
  triggered_by      text NOT NULL,         -- 'scheduler' | 'manual:<user>' | 'boot'
  users_total       integer,
  groups_total      integer,
  memberships_total integer,
  duration_ms       integer,
  error_message     text
);
CREATE INDEX IF NOT EXISTS ad_directory_syncs_started_idx ON ad_directory_syncs (started_at DESC);

-- Trava: apenas 1 sync 'running' por vez. Permite POST manual coexistir com
-- o scheduler sem condições de corrida (segundo POST cai aqui e retorna 409).
CREATE UNIQUE INDEX IF NOT EXISTS ad_directory_syncs_only_one_running
  ON ad_directory_syncs ((1)) WHERE status = 'running';
