// SPDX-License-Identifier: AGPL-3.0-only
// Governance schema v1 (LLD-05). LibreChat data stays in MongoDB, not here.
//
// Conventions:
// - PK id uuid v7; every tenant-owned table has tenant_id + index.
// - Money: bigint micro-USD. Tokens: bigint. Never floats.
// - RLS on every tenant-owned table (see rls.ts): using (tenant_id = current_setting('app.tenant_id')::uuid).
import { sql } from 'drizzle-orm';
import {
  check,
  bigint,
  boolean,
  char,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  numeric,
} from 'drizzle-orm/pg-core';

/** citext column (case-insensitive text) for emails. */
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---- Tenancy ----

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'), // active/suspended/deleted
  region: text('region').notNull().default('eu'), // eu/tr
  kvkkAddon: boolean('kvkk_addon').notNull().default(false),
  customDomain: text('custom_domain'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const plans = pgTable(
  'plans',
  {
    code: text('code').notNull(), // starter/business/studio/community
    version: integer('version').notNull(),
    priceUsdMicro: bigint('price_usd_micro', { mode: 'number' }).notNull(),
    monthlyPriceUsdMicro: bigint('monthly_price_usd_micro', { mode: 'number' }).notNull(),
    stdTokens: bigint('std_tokens', { mode: 'number' }).notNull(),
    premTokens: bigint('prem_tokens', { mode: 'number' }).notNull(),
    researchRuns: integer('research_runs').notNull(),
    filesGb: integer('files_gb').notNull(),
    features: jsonb('features').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('plans_code_version_uq').on(t.code, t.version)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    billingCycle: text('billing_cycle').notNull(), // annual/monthly
    status: text('status').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    lagoSubscriptionId: text('lago_subscription_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('subscriptions_tenant_idx').on(t.tenantId)],
);

export const seats = pgTable(
  'seats',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planCode: text('plan_code').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.planCode] })],
);

export const departments = pgTable(
  'departments',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    budgetUsdMicro: bigint('budget_usd_micro', { mode: 'number' }),
    policyOverride: jsonb('policy_override'),
    createdAt: createdAt(),
  },
  (t) => [unique('departments_tenant_name_uq').on(t.tenantId, t.name)],
);

export const departmentManagers = pgTable(
  'department_managers',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id),
    userId: uuid('user_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.departmentId, t.userId] }),
    index('dept_managers_tenant_idx').on(t.tenantId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keycloakId: text('keycloak_id').notNull().unique(),
    email: citext('email').notNull(),
    name: text('name').notNull(),
    departmentId: uuid('department_id').references(() => departments.id),
    role: text('role').notNull().default('user'), // admin/manager/user
    seatPlanCode: text('seat_plan_code'),
    status: text('status').notNull().default('active'), // active/disabled
    userCapUsdMicro: bigint('user_cap_usd_micro', { mode: 'number' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('users_tenant_email_uq').on(t.tenantId, t.email),
    index('users_keycloak_idx').on(t.keycloakId),
  ],
);

export const gatewayKeys = pgTable(
  'gateway_keys',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    keyHash: text('key_hash').notNull(), // argon2id
    prefix: text('prefix').notNull(),
    type: text('type').notNull().default('tenant'), // tenant/user/service
    userId: uuid('user_id').references(() => users.id),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('gateway_keys_tenant_idx').on(t.tenantId)],
);

// ---- Policy ----

export const DEFAULT_CHAT_RETENTION_MONTHS = 12;

export const tenantPolicies = pgTable(
  'tenant_policies',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    policy: jsonb('policy').notNull(),
    version: integer('version').notNull().default(1),
    /** Its own column, not in `policy`: the gateway has no use for it, and the daily job reads it. */
    chatRetentionMonths: integer('chat_retention_months')
      .notNull()
      .default(DEFAULT_CHAT_RETENTION_MONTHS),
    updatedBy: uuid('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tenant_policies_chat_retention_months', sql`${t.chatRetentionMonths} between 1 and 120`),
  ],
);

export const policyHistory = pgTable(
  'policy_history',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: integer('version').notNull(),
    policy: jsonb('policy').notNull(),
    changedBy: uuid('changed_by'),
    changedAt: createdAt(),
  },
  (t) => [index('policy_history_tenant_idx').on(t.tenantId)],
);

export const accessRules = pgTable('access_rules', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  ipAllowlist: text('ip_allowlist')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  countries: char('countries', { length: 2 })
    .array()
    .notNull()
    .default(sql`'{}'::char(2)[]`),
  mfaRequired: boolean('mfa_required').notNull().default(true),
  sessionIdleMin: integer('session_idle_min').notNull().default(30),
  sessionMaxH: integer('session_max_h').notNull().default(12),
  deviceTrust: jsonb('device_trust'),
  updatedAt: updatedAt(),
});

// ---- Model catalog and routing ----

export const modelCatalog = pgTable('model_catalog', {
  id: text('id').primaryKey(),
  litellmName: text('litellm_name').notNull(),
  displayName: text('display_name').notNull(),
  class: text('class').notNull(), // standard/premium/tr/embedding
  provider: text('provider').notNull(),
  region: text('region').notNull(),
  dataPolicy: text('data_policy').notNull(), // zero_retention/30d/unknown
  priceInUsdMicroPerM: bigint('price_in_usd_micro_per_m', { mode: 'number' }).notNull(),
  priceOutUsdMicroPerM: bigint('price_out_usd_micro_per_m', { mode: 'number' }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

export const tenantModelAllow = pgTable(
  'tenant_model_allow',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    modelId: text('model_id')
      .notNull()
      .references(() => modelCatalog.id),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.modelId] })],
);

export const routerRules = pgTable('router_rules', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull().default('global'), // global/tenant
  tenantId: uuid('tenant_id').references(() => tenants.id),
  priority: integer('priority').notNull(),
  condition: jsonb('condition').notNull(),
  route: jsonb('route').notNull(),
  enabled: boolean('enabled').notNull().default(true),
});

// ---- Usage ----

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    departmentId: uuid('department_id'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    alias: text('alias').notNull(),
    modelId: text('model_id').notNull(),
    class: text('class').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    cachedTokens: bigint('cached_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    costUsdMicro: bigint('cost_usd_micro', { mode: 'number' }).notNull(),
    priceUsdMicro: bigint('price_usd_micro', { mode: 'number' }).notNull(),
    conversationId: text('conversation_id'),
    source: text('source').notNull(), // chat/embedding/research/flow
    flowRunId: uuid('flow_run_id'),
    fallback: boolean('fallback').notNull().default(false),
    overage: boolean('overage').notNull().default(false),
    requestId: text('request_id'),
    /** Tools the model asked to call: names only, one entry per call, never arguments. */
    toolCalls: text('tool_calls')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    index('usage_events_tenant_ts_idx').on(t.tenantId, t.ts),
    index('usage_events_tenant_user_ts_idx').on(t.tenantId, t.userId, t.ts),
    index('usage_events_tenant_dept_ts_idx').on(t.tenantId, t.departmentId, t.ts),
  ],
);

export const usageDaily = pgTable(
  'usage_daily',
  {
    tenantId: uuid('tenant_id').notNull(),
    day: date('day').notNull(),
    userId: uuid('user_id').notNull(),
    departmentId: uuid('department_id'),
    class: text('class').notNull(),
    modelId: text('model_id').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costUsdMicro: bigint('cost_usd_micro', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.day, t.userId, t.class, t.modelId] }),
    index('usage_daily_tenant_day_idx').on(t.tenantId, t.day),
  ],
);

export const tenantLimits = pgTable(
  'tenant_limits',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    month: text('month').notNull(), // yyyymm UTC
    stdTokens: bigint('std_tokens', { mode: 'number' }).notNull(),
    premTokens: bigint('prem_tokens', { mode: 'number' }).notNull(),
    researchRuns: integer('research_runs').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.month] })],
);

export const budgetAlerts = pgTable(
  'budget_alerts',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scope: text('scope').notNull(), // tenant/department/user
    scopeId: text('scope_id').notNull(),
    month: text('month').notNull(),
    threshold: integer('threshold').notNull(), // 50/80/100
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('budget_alerts_uq').on(t.tenantId, t.scope, t.scopeId, t.month, t.threshold)],
);

// ---- Requests, audit, jobs ----

export const requests = pgTable(
  'requests',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('requests_tenant_idx').on(t.tenantId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id'),
    actorType: text('actor_type').notNull(), // user/provider/system
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    ip: text('ip'),
    details: jsonb('details'),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_tenant_ts_idx').on(t.tenantId, t.ts.desc())],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    status: text('status').notNull().default('pending'),
    payload: jsonb('payload'),
    result: jsonb('result'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('jobs_tenant_idx').on(t.tenantId)],
);

/** The central bank's published rates, for invoicing in TRY (LLD-06). Not any company's. */
export const fxRates = pgTable(
  'fx_rates',
  {
    rateDate: date('rate_date').notNull(),
    currency: text('currency').notNull(),
    buying: numeric('buying', { precision: 14, scale: 4 }).notNull(),
    selling: numeric('selling', { precision: 14, scale: 4 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.rateDate, t.currency] })],
);

export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    type: text('type').notNull(), // export/delete
    status: text('status').notNull().default('pending'),
    fileUrl: text('file_url'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('privacy_requests_tenant_idx').on(t.tenantId)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lagoInvoiceId: text('lago_invoice_id'),
    number: text('number').notNull(),
    totalUsdMicro: bigint('total_usd_micro', { mode: 'number' }).notNull(),
    totalTryKurus: bigint('total_try_kurus', { mode: 'number' }).notNull(),
    fxRate: integer('fx_rate').notNull(),
    efaturaStatus: text('efatura_status'),
    efaturaUuid: text('efatura_uuid'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invoices_tenant_idx').on(t.tenantId)],
);
