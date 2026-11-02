// SPDX-License-Identifier: AGPL-3.0-only
// Runs inside its own image on the backend network, started by scripts/setup/tenant-cli.mjs.
// Needs no Docker socket: the host-side script does the Docker work (LLD-07 §2).
import { createLogger, loadEnv } from '@katip/shared';
import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { KeycloakAdmin } from './keycloak.js';
import { createTenant, ProvisionError, type EnsureMongoUser } from './provision.js';
import { DbProvisionerStore } from './store.js';

const ConfigSchema = z.object({
  /** As katip_provider. */
  DATABASE_URL: z.string().url(),
  KEYCLOAK_URL: z.string().url(),
  KEYCLOAK_REALM: z.string().min(1),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1),
  MONGO_ROOT_URI: z.string().min(1),
  TENANT_INPUT: z.string().min(1),
  TENANT_GATEWAY_KEY: z.string().min(1),
  TENANT_OIDC_CLIENT_SECRET: z.string().min(1),
  TENANT_MONGO_PASSWORD: z.string().min(1),
});

const log = createLogger('provisioner');

/** The tenant's Mongo login, limited to its own database (LLD-07 step 3). */
const mongoUsers =
  (rootUri: string): EnsureMongoUser =>
  async (database, password) => {
    const client = new MongoClient(rootUri);
    try {
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
    } finally {
      await client.close();
    }
  };

const config = loadEnv(ConfigSchema);
const store = new DbProvisionerStore(config.DATABASE_URL);
try {
  const result = await createTenant(
    {
      store,
      identity: new KeycloakAdmin({
        url: config.KEYCLOAK_URL,
        realm: config.KEYCLOAK_REALM,
        clientId: config.KEYCLOAK_CLIENT_ID,
        clientSecret: config.KEYCLOAK_CLIENT_SECRET,
      }),
      ensureMongoUser: mongoUsers(config.MONGO_ROOT_URI),
    },
    JSON.parse(config.TENANT_INPUT),
    {
      gatewayKey: config.TENANT_GATEWAY_KEY,
      oidcClientSecret: config.TENANT_OIDC_CLIENT_SECRET,
      mongoPassword: config.TENANT_MONGO_PASSWORD,
    },
  );
  // For the host-side script. No secrets and no email addresses.
  console.log(`provision-result=${JSON.stringify(result)}`);
} catch (e) {
  const step = e instanceof ProvisionError ? e.step : 'input';
  log.error({ event: 'provision_failed', step, err: (e as Error).name }, 'provisioning failed');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await store.close();
}
