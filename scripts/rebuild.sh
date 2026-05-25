#!/usr/bin/env bash
#
# rebuild.sh — rebuild da imagem do app e restart do container, sem mexer
# no postgres. Use depois de puxar mudanças que afetem código TS/UI/SQL.
#
# Uso:
#   scripts/rebuild.sh              # rebuild com cache (mais rápido)
#   scripts/rebuild.sh --no-cache   # rebuild do zero (use após bump de deps)
#   scripts/rebuild.sh --pull       # git pull origin main antes de tudo
#
# Pré-requisitos:
#   - .env presente na raiz (POSTGRES_PASSWORD, JWT_SECRET, INGEST_TOKEN)
#   - docker compose up -d já tendo sido executado pelo menos uma vez
#     (o serviço postgres precisa existir e estar saudável)

set -euo pipefail

# Sempre operar a partir da raiz do repo
cd "$(dirname "$0")/.."

NO_CACHE=""
DO_PULL=0
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    --pull) DO_PULL=1 ;;
    -h|--help)
      sed -n '3,15p' "$0"
      exit 0
      ;;
    *)
      echo "Argumento desconhecido: $arg" >&2
      echo "Use --help para ver as opções." >&2
      exit 2
      ;;
  esac
done

log() { printf '\n\033[1;36m→ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

if [[ ! -f .env ]]; then
  fail ".env não encontrado na raiz do repo. Não é possível subir sem segredos."
  exit 1
fi

if [[ "$DO_PULL" -eq 1 ]]; then
  log "git pull origin main"
  git pull origin main
fi

if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
  warn "Há mudanças não commitadas — vou rebuildar o working tree atual mesmo assim."
fi

# Garantir que o postgres está de pé antes de tentar migrar
if ! docker compose ps --status running --services 2>/dev/null | grep -q '^postgres$'; then
  log "Subindo postgres (estava parado)"
  docker compose up -d postgres
  # pequeno wait pro healthcheck inicial passar
  for _ in {1..30}; do
    status=$(docker inspect -f '{{.State.Health.Status}}' adminsearch-postgres 2>/dev/null || echo starting)
    [[ "$status" == "healthy" ]] && break
    sleep 2
  done
fi

log "Build da imagem do app${NO_CACHE:+ (sem cache)}"
# shellcheck disable=SC2086
docker compose build $NO_CACHE adminsearch

log "Aplicando migrations pendentes"
if docker compose run --rm adminsearch npm run db:migrate; then
  ok "migrations OK"
else
  warn "db:migrate retornou erro — verifique se há migrations novas em drizzle/."
fi

log "Recriando container do app"
docker compose up -d adminsearch

log "Aguardando healthcheck (até 90s)"
healthy=0
for i in {1..45}; do
  status=$(docker inspect -f '{{.State.Health.Status}}' adminsearch 2>/dev/null || echo starting)
  if [[ "$status" == "healthy" ]]; then
    ok "container healthy (após ${i} tentativas de 2s)"
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -ne 1 ]]; then
  fail "container não ficou healthy em 90s. Últimos logs:"
  docker compose logs --tail=60 adminsearch
  exit 3
fi

log "Smoke test /healthz"
if curl -fsS http://127.0.0.1:3010/healthz >/dev/null; then
  ok "/healthz respondeu 200"
else
  warn "não consegui bater em /healthz na porta local — verifique a rede/proxy."
fi

log "Últimas linhas do log do app"
docker compose logs --tail=20 adminsearch

ok "rebuild concluído."
