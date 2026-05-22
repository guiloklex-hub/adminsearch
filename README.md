# adminsearch

Inventário consolidado de **usuários com privilégio de administrador local** no parque Windows da empresa. Resolve a pergunta:

> Quem tem `Administrator` local em quais máquinas, com qual severidade, e o que mudou desde o último scan?

Composição:

- **Agente PowerShell** (`scripts/Get-LocalAdmins.ps1`) distribuído via ScreenConnect e auto-instalado como Scheduled Task diária.
- **Servidor central** (Fastify + Drizzle + Postgres) que recebe os scans, deduplica, cruza com o AD via LDAP read-only, calcula severidade, gera diff entre coletas e expõe BI/relatórios.
- **Web UI** (React 19 + ECharts) com Dashboard, Máquinas, Achados, Eventos e Configurações.

## Stack

Node.js 22 · TypeScript · Fastify 5 · Drizzle ORM · PostgreSQL 16 · Vite + React 19 · TanStack Query · ECharts · Pino · Zod · argon2id · ldapts · Vitest · Biome.

## Quick start (Docker compose)

```bash
git clone <repo>
cd adminsearch
cp .env.example .env

# Gera os 3 segredos
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
echo "JWT_SECRET=$(openssl rand -base64 64)"       >> .env
echo "INGEST_TOKEN=$(openssl rand -base64 32)"     >> .env

# Edite .env e preencha LDAP_URL / LDAP_BIND_DN / LDAP_BIND_PASSWORD / LDAP_BASE_DN.
# Se o LDAPS usa CA interna, monte o PEM em ./mm-ca.crt e descomente o volume
# correspondente em docker-compose.yml; defina LDAP_TLS_CA_FILE=/etc/adminsearch/mm-ca.crt.

docker compose up -d
docker compose logs -f adminsearch
```

Acesse `http://<host>:3010` — na primeira visita o setup wizard cria o admin local.

## Preparando o script PowerShell para ScreenConnect

1. Edite `scripts/Get-LocalAdmins.ps1`.
2. Cole o conteúdo PEM da CA interna (Root + Sub) no bloco `$InternalCaPem`. Use o `scripts/ocs.ps1` do repositório irmão `scripts/` como referência.
3. No backstage do ScreenConnect, rode em uma máquina-piloto:

```powershell
.\Get-LocalAdmins.ps1 `
    -IngestUrl   "https://adminsearch.madeiramadeira.com.br/api/v1/ingest" `
    -IngestToken "<o valor de INGEST_TOKEN do .env>" `
    -Source      screenconnect `
    -InstallTask
```

`-InstallTask` copia o script para `%ProgramData%\adminsearch\agent.ps1` e registra a Scheduled Task `MM-AdminSearch-Daily` (06:00 + AtStartup). A coleta inicial roda no mesmo comando.

Para desfazer em uma máquina: `.\Get-LocalAdmins.ps1 -IngestUrl <x> -IngestToken <x> -Uninstall`.

## Modelo de dados (resumido)

| Tabela | Função |
|---|---|
| `machines` | uma linha por máquina física (identidade canônica por FQDN + serial BIOS/UUID) |
| `scan_runs` | cada execução do agente, idempotente por `scan_id` (UUID gerado no PS) |
| `raw_members` | snapshot exato do que o agente viu no grupo `Administrators` local |
| `ad_users` | cache de atributos do AD (TTL 24h padrão) |
| `effective_members` | usuários EFETIVOS pós-expansão recursiva de grupos AD, com `severity` |
| `findings_events` | diff `ADMIN_ADDED` / `ADMIN_REMOVED` / `ORPHAN_DETECTED` / `MACHINE_RENAMED` |
| `exceptions` | whitelist (escopo global / por máquina / por tag) |
| `admins` | single-admin local da Web UI (argon2id) |
| `audit_log` | login, exceções, change-password |

## API principal

| Método | Rota | Auth |
|---|---|---|
| POST | `/api/v1/ingest` | Bearer `INGEST_TOKEN` |
| POST | `/api/v1/auth/login` | público (rate-limited) |
| GET  | `/api/v1/machines` | sessão |
| GET  | `/api/v1/machines/:id` | sessão |
| PATCH | `/api/v1/machines/:id` | sessão |
| GET  | `/api/v1/findings` | sessão |
| GET  | `/api/v1/findings/by-user` | sessão |
| GET  | `/api/v1/findings/by-group` | sessão |
| GET  | `/api/v1/events` | sessão |
| GET  | `/api/v1/stats/dashboard` | sessão |
| GET / POST / DELETE | `/api/v1/exceptions[/:id]` | sessão |
| GET  | `/api/v1/export/findings.csv` | sessão |
| POST | `/api/v1/ad/test` | sessão |
| GET  | `/healthz` | público |

Contrato Zod compartilhado entre PS↔servidor: [`src/shared/ingest-contract.ts`](src/shared/ingest-contract.ts).

## Severidade (heurística)

| Condição | Severity |
|---|---|
| SID órfão (não resolve no AD nem é local) | `critical` |
| Conta AD nominal, **desabilitada** ainda no grupo | `critical` |
| Conta AD nominal habilitada, sem exception | `high` |
| Service account AD (heurística por OU/sufixo) | `medium` |
| Conta local da máquina | `medium` |
| Built-in (S-1-5-32-544, Domain Admins...) | `low` |
| Coberta por `exceptions` | `info` |

## Verificação end-to-end (após primeiro deploy)

1. `docker compose ps` — ambos containers `healthy`.
2. `curl -s http://localhost:3010/healthz` → `{"status":"ok"}`.
3. Acesse a Web UI e crie o admin no setup wizard.
4. Em `/settings` → "Testar conexão LDAP" → deve retornar `Bind OK`.
5. Rode o agent em uma VM de teste (modo `-Source manual`) → máquina aparece em `/machines` < 30s.
6. Em `/machines/:id` confira os admins resolvidos com severidade.
7. Adicione um usuário no Administrators local e re-rode → `/events` mostra `ADMIN_ADDED`.
8. Crie uma exception em `/settings` para um grupo conhecido → no próximo enricher run a severidade vira `info`.
9. Em `/findings` → "Exportar CSV" → planilha abre no Excel (UTF-8 BOM).
10. Em `Scheduled Tasks` da VM, `MM-AdminSearch-Daily` deve estar listada.

## Runbook (operação)

### Rotacionar `INGEST_TOKEN`
1. Gere novo: `openssl rand -base64 32`.
2. Atualize `.env` e reinicie: `docker compose up -d adminsearch`.
3. Edite `scripts/Get-LocalAdmins.ps1` (ou re-distribua via ScreenConnect) com o novo token.
4. Aguarde 24h e veja em `/machines` se ainda há agentes com `last_seen_at` antigo — eles ainda têm o token velho.

### Reset de senha do admin local
Acesse o Postgres: `docker exec -it adminsearch-postgres psql -U adminsearch_app -d adminsearch`
```sql
DELETE FROM admins;
```
A próxima visita à Web UI volta a oferecer o setup wizard.

### Reprocessar scan que falhou no enricher
Em `/machines/:id` a aba "Histórico de scans" mostra `expansion_status=failed`. Para forçar retry:
```sql
UPDATE scan_runs SET expansion_status='pending', expansion_error=NULL
WHERE expansion_status='failed';
```
O enricher pega no próximo poll (default 5s).

### Pausar o enricher
Sem feature flag — basta desconfigurar `LDAP_URL` ou parar o container `adminsearch`. Os scans continuam chegando mas ficam `pending`.

### Backup
`pg_dump` no container Postgres é suficiente — não há binários grandes no banco.
```bash
docker exec adminsearch-postgres pg_dump -U adminsearch_app -d adminsearch | gzip > backup-$(date +%F).sql.gz
```

## Estrutura

```
adminsearch/
├── scripts/
│   └── Get-LocalAdmins.ps1     # agente Windows
├── src/
│   ├── server/                  # Fastify + Drizzle + enricher LDAP
│   ├── shared/                  # contrato Zod compartilhado
│   └── web/                     # React 19 + ECharts SPA
├── drizzle/                     # migrações SQL aplicadas no boot
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Histórico de versões

| Versão | Data | Notas |
|---|---|---|
| 0.1.0 | 2026-05-22 | Primeira versão — ingestão, enricher LDAP, BI, exportação CSV. |
