import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL deve iniciar com `postgres://` ou `postgresql://`')
    .default('postgresql://adminsearch_app:CHANGE_ME@localhost:5432/adminsearch'),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET obrigatório (>= 32 chars; gere com `openssl rand -base64 64`)'),

  INGEST_TOKEN: z
    .string()
    .min(16, 'INGEST_TOKEN obrigatório (>= 16 chars; gere com `openssl rand -base64 32`)'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // LDAP — opcionais; sem LDAP_URL o enricher fica desabilitado mas a app sobe.
  LDAP_URL: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_BASE_DN: z.string().optional(),
  LDAP_TLS_CA_FILE: z.string().optional(),

  STALE_AGENT_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  AD_USER_CACHE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  ENRICHER_POLL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),

  COOKIE_SECURE: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v))
    .default(true),
  COOKIE_DOMAIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida em variáveis de ambiente:\n${issues}`);
  }
  return result.data;
}

export function ldapConfigured(env: Env): boolean {
  return Boolean(env.LDAP_URL && env.LDAP_BIND_DN && env.LDAP_BIND_PASSWORD && env.LDAP_BASE_DN);
}
