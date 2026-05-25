-- adminsearch — v0.5.0 — Grupos institucionais cadastrados manualmente
-- Permite ao operador cadastrar SIDs (grupos do AD da empresa que o LDAP
-- não consegue resolver automaticamente) com nome amigável + sAMAccountName
-- de hint. O enricher consulta essa tabela antes de classificar.

CREATE TABLE IF NOT EXISTS institutional_groups (
  sid                  text PRIMARY KEY,
  display_name         text NOT NULL,
  sam_account_name     text,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
