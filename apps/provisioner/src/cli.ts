// SPDX-License-Identifier: AGPL-3.0-only
// Runs inside its own image on the backend network, started by scripts/setup/steps.mjs.
// Needs no Docker socket: the host-side script does the Docker work (LLD-07 §2).
import { createLogger, loadEnv } from '@katip/shared';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { KeycloakAdmin } from './keycloak.js';
import {
  deleteTenant,
  finishPurge,
  purgesDue,
  resumeTenant,
  startPurge,
  suspendTenant,
} from './lifecycle.js';
import {
  createTenant,
  ensureRagKey,
  finishTenant,
  ProvisionError,
  rollbackTenant,
  type ProvisionDeps,
} from './provision.js';
import { deletionLookup, deletionsDue, finishDeletion, type ForgetDeps } from './forget.js';
import { findLibreChatFiles, findLibreChatUser, forgetLibreChatUser } from './librechat-data.js';
import { DbProvisionerStore } from './store.js';

const ConfigSchema = z.object({
  /** As katip_provider. */
  DATABASE_URL: z.string().url(),
  KEYCLOAK_URL: z.string().url(),
  KEYCLOAK_REALM: z.string().min(1),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1),
  MONGO_ROOT_URI: z.string().min(1),
  TENANT_ACTION: z.enum([
    'create',
    'finish',
    'rag-key',
    'rollback',
    'suspend',
    'resume',
    'delete',
    'purges-due',
    'purge-start',
    'purge-finish',
    'deletions-due',
    'deletion-lookup',
    'deletion-finish',
    'daily-retention',
    'daily-record',
    'fx-store',
  ]),
  TENANT_INPUT: z.string().min(1),
  /** Only for the stages that set a tenant up. */
  TENANT_GATEWAY_KEY: z.string().default(''),
  TENANT_RAG_GATEWAY_KEY: z.string().default(''),
  TENANT_OIDC_CLIENT_SECRET: z.string().default(''),
  TENANT_MONGO_PASSWORD: z.string().default(''),
  /** finish: what the create stage changed, for the audit entry. */
  TENANT_PRIOR_STEPS: z.string().default('[]'),
  /** rollback: why it's happening, for the job. */
  TENANT_FAILED_STEP: z.string().default('unknown'),
});

const log = createLogger('provisioner');

const withMongo = async <T>(
  rootUri: string,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> => {
  const client = new MongoClient(rootUri);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
};

const config = loadEnv(ConfigSchema);
const store = new DbProvisionerStore(config.DATABASE_URL);
const keycloak = new KeycloakAdmin({
  url: config.KEYCLOAK_URL,
  realm: config.KEYCLOAK_REALM,
  clientId: config.KEYCLOAK_CLIENT_ID,
  clientSecret: config.KEYCLOAK_CLIENT_SECRET,
});
const deps: ProvisionDeps = {
  store,
  identity: keycloak,
  // The tenant's Mongo login, limited to its own database (LLD-07 step 3).
  ensureMongoUser: (database, password) =>
    withMongo(config.MONGO_ROOT_URI, async (client) => {
      const db = client.db(database);
      const { users } = (await db.command({ usersInfo: database })) as { users: unknown[] };
      const roles = [{ role: 'readWrite', db: database }];
      if (users.length > 0) {
        // The secrets file is the source of truth, so keep the password in step with it.
        await db.command({ updateUser: database, pwd: password, roles });
        return false;
      }
      await db.command({ createUser: database, pwd: password, roles });
      return true;
    }),
  dropMongoDatabase: (database) =>
    withMongo(config.MONGO_ROOT_URI, async (client) => {
      const db = client.db(database);
      await db.command({ dropAllUsersFromDatabase: 1 });
      await db.dropDatabase();
    }),
};

const forgetDeps: ForgetDeps = {
  store,
  identity: keycloak,
  findLibreChatUser: (database, email, keycloakId) =>
    withMongo(config.MONGO_ROOT_URI, (client) =>
      findLibreChatUser(client.db(database), email, keycloakId),
    ),
  findLibreChatFiles: (database, lcUserId) =>
    withMongo(config.MONGO_ROOT_URI, (client) => findLibreChatFiles(client.db(database), lcUserId)),
  forgetLibreChatUser: (database, lcUserId, email) =>
    withMongo(config.MONGO_ROOT_URI, (client) =>
      forgetLibreChatUser(client.db(database), lcUserId, email),
    ),
};

try {
  const input: unknown = JSON.parse(config.TENANT_INPUT);
  const { slug } = z.object({ slug: z.string() }).parse(input);
  const requestOf = () => z.object({ requestId: z.string().uuid() }).parse(input).requestId;
  const lifecycle: Record<string, () => Promise<unknown>> = {
    'rag-key': () => ensureRagKey(deps, slug, config.TENANT_RAG_GATEWAY_KEY),
    suspend: () => suspendTenant(deps, slug),
    resume: () => resumeTenant(deps, slug),
    delete: () => deleteTenant(deps, slug),
    'purges-due': async () => ({ slugs: await purgesDue(deps) }),
    'purge-start': () => startPurge(deps, slug),
    'purge-finish': () => finishPurge(deps, slug),
    'deletions-due': async () => ({ deletions: await deletionsDue(forgetDeps) }),
    'deletion-lookup': () => deletionLookup(forgetDeps, slug, requestOf()),
    'deletion-finish': () => finishDeletion(forgetDeps, slug, requestOf()),
    'daily-retention': () => store.enforceRetention(),
    'fx-store': async () => ({
      added: await store.saveFxRate(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            currency: z.literal('USD'),
            buying: z.string().regex(/^\d+\.\d+$/),
            selling: z.string().regex(/^\d+\.\d+$/),
          })
          .parse(input),
      ),
    }),
    'daily-record': () =>
      store.recordDailyRun(
        z
          .object({
            deleted: z.number(),
            purged: z.number(),
            failed: z.number(),
            expiredUsage: z.number(),
            expiredAudit: z.number(),
            fxDate: z.string().nullable(),
          })
          .parse(input),
      ),
  };
  const action = lifecycle[config.TENANT_ACTION];
  if (action) {
    console.log(`provision-result=${JSON.stringify((await action()) ?? {})}`);
  } else if (config.TENANT_ACTION === 'rollback') {
    await rollbackTenant(deps, input, config.TENANT_FAILED_STEP);
    console.log('provision-result={}');
  } else {
    const result =
      config.TENANT_ACTION === 'create'
        ? await createTenant(deps, input, {
            gatewayKey: config.TENANT_GATEWAY_KEY,
            oidcClientSecret: config.TENANT_OIDC_CLIENT_SECRET,
            mongoPassword: config.TENANT_MONGO_PASSWORD,
          })
        : await finishTenant(
            deps,
            input,
            z.array(z.string()).parse(JSON.parse(config.TENANT_PRIOR_STEPS)),
          );
    // For the host-side script. No secrets and no email addresses.
    console.log(`provision-result=${JSON.stringify(result)}`);
  }
} catch (e) {
  const step = e instanceof ProvisionError ? e.step : 'input';
  log.error({ event: 'provision_failed', step, err: (e as Error).name }, 'provisioning failed');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await store.close();
}
