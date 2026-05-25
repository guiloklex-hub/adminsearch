-- adminsearch — v0.4.0 — Política de severidade global por motivo
-- Permite ao operador sobrescrever, globalmente, a severidade default
-- atribuída a cada caminho da árvore de decisão de `classifySeverity`.

-- 1) Persistir o `reasonCode` que justificou a classificação atual de cada
--    membro efetivo. Nullable nesta migration; o script
--    `npm run backfill:reason-codes` preenche as linhas existentes a partir
--    dos sinais já persistidos (source, viaGroup, viaGroupSid, adEnabled,
--    isServiceAccount, matchedExceptionId). Depois do backfill, pode-se
--    promover para NOT NULL numa migration seguinte.
ALTER TABLE effective_members
  ADD COLUMN IF NOT EXISTS reason_code text;

CREATE INDEX IF NOT EXISTS effective_members_reason_idx
  ON effective_members (reason_code);

-- 2) Tabela de overrides. Linha presente = override ativo. Ausência = usa
--    o default do código (DEFAULT_SEVERITY_BY_REASON em severity.ts).
CREATE TABLE IF NOT EXISTS severity_policies (
  reason_code        text PRIMARY KEY,
  severity_override  text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text NOT NULL
);
