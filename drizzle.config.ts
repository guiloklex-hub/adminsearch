import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://adminsearch:adminsearch@localhost:5432/adminsearch',
  },
  verbose: true,
  strict: true,
});
