# Política de Segurança

## Reportando vulnerabilidades

Encontrou uma falha de segurança? **Não abra uma issue pública.**

Use o canal privado do GitHub:

1. Abra a aba **Security** do repositório.
2. Clique em **Report a vulnerability**.
3. Descreva o problema, impacto estimado e passos de reprodução.

Esse fluxo (Private Vulnerability Reporting) é privado entre você e os mantenedores. Resposta esperada em até **5 dias úteis**.

## Escopo

O `adminsearch` armazena, por design, **dados sensíveis sobre o parque corporativo** (hostnames, SIDs do AD, atributos de usuários, lista de quem tem privilégio administrativo onde). Falhas que afetem confidencialidade desses dados são tratadas como prioridade alta.

Especialmente interessadas:

- IDOR / vazamento entre sessões de admin (apesar de ser single-admin, qualquer caminho que retorne dados sem `requireSession` é crítico).
- Bypass do Bearer no `/api/v1/ingest` (uso indevido de comparações fora de tempo constante, etc).
- Injeção em filtros LDAP (atributos do AD enviados sem escape).
- XSS na Web UI a partir de campos vindos do agente (hostname, último user logado, displayName do AD).
- Exposição acidental de `INGEST_TOKEN`, `JWT_SECRET` ou `LDAP_BIND_PASSWORD` em logs ou respostas.

## Versões suportadas

Apenas a branch `main` recebe correções de segurança. Não há releases LTS.

## Boas práticas para deploys

- Coloque o serviço atrás de um reverse proxy com TLS (Cloudflare Tunnel, nginx, Traefik) — o container expõe HTTP por padrão.
- Rotacione `INGEST_TOKEN` periodicamente (ex.: a cada 6 meses) e redistribua o script via ScreenConnect.
- Use uma service account LDAP **somente-leitura**, dedicada ao adminsearch.
- Mantenha `COOKIE_SECURE=true` em produção.
- Monitore o painel **Security** do GitHub para alertas de dependências.
