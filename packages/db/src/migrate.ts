// SPDX-License-Identifier: AGPL-3.0-only
// Forward migrations from ./drizzle/*.sql (tracked by drizzle in __drizzle_migrations),
// then RLS policies (idempotent). LLD-05 §5: runs forward from empty, idempotent in CI.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isCliEntry } from './cli-entry.js';
import {
  BILLING_ROLE_SQL,
  CONSOLE_ROLE_SQL,
  USAGE_ROLLUP_SQL,
  GATEWAY_ROLE_SQL,
  PROVIDER_ROLE_SQL,
  TENANT_OWNED_TABLES,
  tenantRlsSql,
} from './rls.js';
import * as schema from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../drizzle');

export type Db = PostgresJsDatabase<typeof schema>;

/** Applies pending migrations + RLS. Safe to call repeatedly; returns tables under RLS. */
export async function migrateWithClient(client: postgres.Sql): Promise<string[]> {
  const db = drizzle(client, { schema });
  await drizzleMigrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // RLS after schema exists. CREATE POLICY has no IF NOT EXISTS, so drop + recreate.
  for (const table of TENANT_OWNED_TABLES) {
    await client.unsafe(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    await client.unsafe(tenantRlsSql(table));
  }
  await client.unsafe(PROVIDER_ROLE_SQL);
  await client.unsafe(GATEWAY_ROLE_SQL);
  await client.unsafe(USAGE_ROLLUP_SQL);
  await client.unsafe(CONSOLE_ROLE_SQL);
  await client.unsafe(BILLING_ROLE_SQL);
  return [...TENANT_OWNED_TABLES];
}

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await migrateWithClient(client);
  } finally {
    await client.end();
  }
}

// CLI entry (pnpm db:migrate). DATABASE_URL or GOVERNANCE_DATABASE_URL.
if (isCliEntry(process.argv[1], 'migrate')) {
  const url = process.env['DATABASE_URL'] ?? process.env['GOVERNANCE_DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url)
    .then((tables) => console.log(`migrations applied; RLS active on ${tables.length} tables`))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
