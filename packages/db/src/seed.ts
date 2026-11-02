// SPDX-License-Identifier: AGPL-3.0-only
// Seed data (LLD-05 §4): plans v1, model catalog from LLD-03 §3, router rules v1
// from LLD-03 §4, and a `demo` tenant with 3 users for local dev.
import { and, eq, ne, notInArray } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { isCliEntry } from './cli-entry.js';
import * as schema from './schema.js';

/** What the bootstrap passes from katip.config.yaml; the defaults suit tests and `pnpm db:seed`. */
export interface SeedOptions {
  /** Replaces the default catalog; models not listed get disabled. */
  models?: (typeof schema.modelCatalog.$inferInsert)[];
  /** null seeds the platform data only: plans, catalog and rules. */
  tenant?: {
    slug: string;
    name: string;
    planCode: string;
    seats: number;
    kvkkAddon: boolean;
  } | null;
}

export interface SeedResult {
  tenants: number;
  users: number;
  plans: number;
  models: number;
  rules: number;
}

/** Prices in micro-USD per 1M tokens (LLD-03 §3, converted from the OpenRouter pull). */
const MODELS: (typeof schema.modelCatalog.$inferInsert)[] = [
  {
    id: 'std-deepseek-v4-flash',
    litellmName: 'std-deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    class: 'standard',
    provider: 'deepinfra',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 90_000,
    priceOutUsdMicroPerM: 180_000,
  },
  {
    id: 'std-glm-5.3-flash',
    litellmName: 'std-glm-5.3-flash',
    displayName: 'GLM-5.3 Flash',
    class: 'standard',
    provider: 'z-ai',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 84_000,
    priceOutUsdMicroPerM: 280_000,
  },
  {
    id: 'std-gemma-4-26b',
    litellmName: 'std-gemma-4-26b',
    displayName: 'Gemma 4 26B',
    class: 'standard',
    provider: 'deepinfra',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 70_000,
    priceOutUsdMicroPerM: 340_000,
  },
  {
    id: 'prem-claude-sonnet-5.5',
    litellmName: 'prem-claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    class: 'premium',
    provider: 'anthropic',
    region: 'global',
    dataPolicy: 'retention_30d',
    priceInUsdMicroPerM: 2_000_000,
    priceOutUsdMicroPerM: 10_000_000,
  },
  {
    id: 'prem-gemini-4-argon',
    litellmName: 'prem-gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    class: 'premium',
    provider: 'vertex_ai',
    region: 'eu',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 2_000_000,
    priceOutUsdMicroPerM: 10_000_000,
  },
  {
    id: 'tr-gpt-oss-120b',
    litellmName: 'tr-gpt-oss-120b',
    displayName: 'gpt-oss-120b (Türkiye)',
    class: 'tr',
    provider: 'vllm-tr',
    region: 'tr',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 150_000,
    priceOutUsdMicroPerM: 600_000,
  },
  {
    id: 'emb-bge-m3',
    litellmName: 'emb-bge-m3',
    displayName: 'BGE-M3 embeddings',
    class: 'embedding',
    provider: 'deepinfra',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInUsdMicroPerM: 10_000,
    priceOutUsdMicroPerM: 0,
  },
];

const DEMO_TENANT: NonNullable<SeedOptions['tenant']> = {
  slug: 'demo',
  name: 'Demo A.Ş.',
  planCode: 'business',
  seats: 10,
  kvkkAddon: false,
};

const PLANS: (typeof schema.plans.$inferInsert)[] = [
  {
    code: 'community',
    version: 1,
    priceUsdMicro: 0,
    monthlyPriceUsdMicro: 0,
    stdTokens: 0,
    premTokens: 0,
    researchRuns: 0,
    filesGb: 0,
    features: { selfHost: true, byok: true },
  },
  {
    code: 'starter',
    version: 1,
    priceUsdMicro: 6_000_000,
    monthlyPriceUsdMicro: 7_200_000,
    stdTokens: 4_000_000,
    premTokens: 0,
    researchRuns: 10,
    filesGb: 1,
    features: { chat: true, files: true, webSearch: true, router: true, budgets: true },
  },
  {
    code: 'business',
    version: 1,
    priceUsdMicro: 8_000_000,
    monthlyPriceUsdMicro: 9_600_000,
    stdTokens: 6_000_000,
    premTokens: 500_000,
    researchRuns: 40,
    filesGb: 5,
    features: {
      chat: true,
      files: true,
      webSearch: true,
      router: true,
      budgets: true,
      knowledge: true,
      agents: true,
      governance: true,
      piiMasking: true,
      sso: true,
    },
  },
  {
    code: 'studio',
    version: 1,
    priceUsdMicro: 14_000_000,
    monthlyPriceUsdMicro: 16_800_000,
    stdTokens: 10_000_000,
    premTokens: 1_000_000,
    researchRuns: 60,
    filesGb: 10,
    features: {
      chat: true,
      files: true,
      webSearch: true,
      router: true,
      budgets: true,
      knowledge: true,
      agents: true,
      governance: true,
      piiMasking: true,
      sso: true,
      studioBuilder: true,
    },
  },
  {
    code: 'kvkk_addon',
    version: 1,
    priceUsdMicro: 7_000_000,
    monthlyPriceUsdMicro: 8_400_000,
    stdTokens: 0,
    premTokens: 0,
    researchRuns: 0,
    filesGb: 0,
    features: { trRegion: true, domesticModelRouting: true },
  },
];

const ROUTER_RULES: (typeof schema.routerRules.$inferInsert)[] = [
  {
    id: 'tr-only',
    scope: 'global',
    priority: 10,
    condition: { residency: ['TR_ONLY'] },
    route: { models: ['tr-gpt-oss-120b'], strict: true },
  },
  {
    id: 'tr-local-alias',
    scope: 'global',
    priority: 15,
    condition: { alias: ['tr-local'] },
    route: { models: ['tr-gpt-oss-120b'], strict: true },
  },
  {
    id: 'background',
    scope: 'global',
    priority: 18,
    condition: { background: true },
    route: { models: ['std-glm-5.3-flash', 'std-deepseek-v4-flash'] },
  },
  {
    id: 'best',
    scope: 'global',
    priority: 20,
    condition: { alias: ['best'] },
    route: { models: ['prem-claude-sonnet-5.5', 'prem-gemini-4-argon'] },
  },
  {
    id: 'fast',
    scope: 'global',
    priority: 30,
    condition: { alias: ['fast'] },
    route: {
      models: ['std-deepseek-v4-flash', 'std-glm-5.3-flash', 'std-gemma-4-26b'],
    },
  },
  {
    id: 'auto-escalate',
    scope: 'global',
    priority: 40,
    condition: {
      alias: ['auto'],
      minInputTokens: 60_000,
      reasoningHint: true,
      requiresPremiumQuota: true,
    },
    route: { models: ['prem-claude-sonnet-5.5', 'prem-gemini-4-argon'] },
  },
  {
    id: 'auto-default',
    scope: 'global',
    priority: 50,
    condition: { alias: ['auto'] },
    route: {
      models: ['std-deepseek-v4-flash', 'std-glm-5.3-flash', 'std-gemma-4-26b'],
    },
  },
];

export async function seed(
  db: PostgresJsDatabase<typeof schema>,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const models = opts.models ?? MODELS;
  const tenant = opts.tenant === undefined ? DEMO_TENANT : opts.tenant;

  // Fail before writing: a bad config must not leave a half-applied catalog.
  const modelIds = models.map((m) => m.id);
  for (const r of ROUTER_RULES) {
    for (const id of (r.route as { models: string[] }).models) {
      if (!modelIds.includes(id)) {
        throw new Error(`router rule ${r.id} uses model ${id}, which is not in the catalog`);
      }
    }
  }
  if (tenant && !PLANS.some((p) => p.code === tenant.planCode)) {
    throw new Error(`unknown plan ${tenant.planCode}`);
  }

  // Idempotent upserts; versioned rows (plans) are never updated in place.
  for (const m of models) {
    await db
      .insert(schema.modelCatalog)
      .values(m)
      .onConflictDoUpdate({ target: schema.modelCatalog.id, set: { ...m, enabled: true } });
  }
  await db
    .update(schema.modelCatalog)
    .set({ enabled: false })
    .where(notInArray(schema.modelCatalog.id, modelIds));
  for (const p of PLANS) {
    await db.insert(schema.plans).values(p).onConflictDoNothing();
  }
  for (const r of ROUTER_RULES) {
    await db
      .insert(schema.routerRules)
      .values(r)
      .onConflictDoUpdate({ target: schema.routerRules.id, set: r });
  }

  if (!tenant) {
    return {
      tenants: 0,
      users: 0,
      plans: PLANS.length,
      models: models.length,
      rules: ROUTER_RULES.length,
    };
  }

  // Demo tenant with admin/manager/user (local dev only).
  const demoTenant = await db
    .insert(schema.tenants)
    .values({
      slug: tenant.slug,
      name: tenant.name,
      status: 'active',
      region: 'eu',
      kvkkAddon: tenant.kvkkAddon,
    })
    .onConflictDoUpdate({
      target: schema.tenants.slug,
      set: { name: tenant.name, kvkkAddon: tenant.kvkkAddon },
    })
    .returning();
  const tenantId = demoTenant[0]!.id;

  await db
    .delete(schema.seats)
    .where(and(eq(schema.seats.tenantId, tenantId), ne(schema.seats.planCode, tenant.planCode)));
  await db
    .insert(schema.seats)
    .values({ tenantId, planCode: tenant.planCode, quantity: tenant.seats })
    .onConflictDoUpdate({
      target: [schema.seats.tenantId, schema.seats.planCode],
      set: { quantity: tenant.seats },
    });

  const demoUsers = [
    {
      email: `admin@${tenant.slug}.localhost`,
      name: 'Demo Admin',
      role: 'admin',
      keycloakId: `${tenant.slug}-admin`,
    },
    {
      email: `manager@${tenant.slug}.localhost`,
      name: 'Demo Manager',
      role: 'manager',
      keycloakId: `${tenant.slug}-manager`,
    },
    {
      email: `user@${tenant.slug}.localhost`,
      name: 'Demo User',
      role: 'user',
      keycloakId: `${tenant.slug}-user`,
    },
  ];
  for (const u of demoUsers) {
    // Two unique constraints exist (tenant_id,email) and (keycloak_id); handle both.
    await db
      .insert(schema.users)
      .values({ ...u, tenantId, seatPlanCode: tenant.planCode, status: 'active' })
      .onConflictDoUpdate({
        target: [schema.users.tenantId, schema.users.email],
        set: { name: u.name, role: u.role, keycloakId: u.keycloakId },
      });
  }

  return {
    tenants: 1,
    users: demoUsers.length,
    plans: PLANS.length,
    models: models.length,
    rules: ROUTER_RULES.length,
  };
}

export async function seedFromUrl(databaseUrl: string): Promise<SeedResult> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const db = drizzle(client, { schema });
    return await seed(db);
  } finally {
    await client.end();
  }
}

// CLI entry (pnpm db:seed).
if (isCliEntry(process.argv[1], 'seed')) {
  const url = process.env['DATABASE_URL'] ?? process.env['GOVERNANCE_DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  seedFromUrl(url)
    .then((r) =>
      console.log(
        `seeded: ${r.tenants} tenant, ${r.users} users, ${r.plans} plans, ${r.models} models, ${r.rules} rules`,
      ),
    )
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
