-- adminsearch — v0.2.0 — Remediação ativa
-- Tabela de ações de remoção do Administrators local, com fluxo
-- planned → confirmed → dispatched → executed/failed/refused.

CREATE TABLE IF NOT EXISTS remediation_actions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id            uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,

  target_sid            text NOT NULL,
  target_name           text,
  target_source         text,
  target_is_group       boolean NOT NULL DEFAULT false,
  via_group             text,

  status                text NOT NULL DEFAULT 'planned',

  planned_by            text NOT NULL,
  planned_at            timestamptz NOT NULL DEFAULT now(),
  planned_reason        text,

  confirmed_by          text,
  confirmed_at          timestamptz,

  cancelled_by          text,
  cancelled_at          timestamptz,
  cancel_reason         text,

  dispatched_at         timestamptz,
  dispatched_scan_id    uuid,
  executed_at           timestamptz,
  execution_result      text,
  execution_error       text
);

CREATE INDEX IF NOT EXISTS remediation_actions_status_idx
  ON remediation_actions (status);

CREATE INDEX IF NOT EXISTS remediation_actions_machine_status_idx
  ON remediation_actions (machine_id, status);

CREATE INDEX IF NOT EXISTS remediation_actions_planned_at_idx
  ON remediation_actions (planned_at DESC);

-- Garantia anti-duplicata: só uma ação "em voo" por (máquina, sid).
-- Após executar/falhar/cancelar, pode-se criar outra (histórico permanece).
CREATE UNIQUE INDEX IF NOT EXISTS remediation_actions_active_unique
  ON remediation_actions (machine_id, target_sid)
  WHERE status IN ('planned', 'confirmed', 'dispatched');
