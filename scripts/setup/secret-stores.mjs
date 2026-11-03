// SPDX-License-Identifier: AGPL-3.0-only
// The commands that change a secret where it's stored: Postgres roles, Mongo users, Keycloak.
// A value only ever travels in the environment of `docker exec` or `docker run`, by name
// (`-e NAME`), and is read inside the container. It's never on a command line, so a failure
// message can't show it. Everything shown to a person goes through scrub() as well.
import { run, tail } from './util.mjs';

/** Hides these values, raw and as they'd look in a URL, wherever they occur in the text. */
export function scrub(text, values) {
  let out = String(text);
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out = out.replaceAll(value, '***').replaceAll(encodeURIComponent(value), '***');
  }
  return out;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** `docker exec`, with `env` passed by name. Returns { code, out }, and throws only on a timeout. */
export function execIn(container, env, command, { input, timeoutMs = 60_000 } = {}) {
  const args = [
    'exec',
    ...(input === undefined ? [] : ['-i']),
    ...Object.keys(env).flatMap((name) => ['-e', name]),
    container,
    ...command,
  ];
  return run('docker', args, { env, input, timeoutMs });
}

function failed(what, container, out, values) {
  return new Error(`${what} failed in ${container}: ${scrub(tail(out, 5), values)}`);
}

// ---- Postgres ---------------------------------------------------------------------------------

/**
 * ALTER ROLE as the container's admin, over its socket, so it needs no current password. psql
 * reads the value from the environment and quotes it with :'name', which handles any character.
 * The statement is kept out of the server's log, even if it fails.
 */
export async function pgSetPassword({ container, admin, role, db, value }) {
  if (!IDENTIFIER.test(role) || !IDENTIFIER.test(admin)) {
    throw new Error('a Postgres role name has an unexpected format');
  }
  const script = [
    '\\set ON_ERROR_STOP on',
    '\\set VERBOSITY terse',
    '\\set SHOW_CONTEXT never',
    '\\getenv katip_rotate_value KATIP_ROTATE_VALUE',
    "SET log_statement = 'none';",
    "SET log_min_error_statement = 'panic';",
    `ALTER ROLE "${role}" PASSWORD :'katip_rotate_value';`,
    '',
  ].join('\n');
  const { code, out } = await execIn(
    container,
    { KATIP_ROTATE_VALUE: value },
    ['psql', '-X', '-q', '-U', admin, '-d', db],
    { input: script },
  );
  if (code !== 0) throw failed(`ALTER ROLE ${role}`, container, out, [value]);
}

/**
 * Logs in over the container's own address. The image trusts 127.0.0.1 and the socket without a
 * password, so a check over those would pass with any value.
 */
export async function pgCanLogin({ container, role, db, value }) {
  const { code, out } = await execIn(
    container,
    { PGPASSWORD: value, KATIP_ROLE: role, KATIP_DB: db },
    [
      'sh',
      '-c',
      'exec psql -X -w -q -At -h "$(hostname -i | cut -d" " -f1)" -U "$KATIP_ROLE" -d "$KATIP_DB" -c "select 1"',
    ],
  );
  return code === 0 && out.trim() === '1';
}

// ---- Mongo ------------------------------------------------------------------------------------

const mongosh = (container, env, code) =>
  execIn(container, env, [
    'mongosh',
    '--quiet',
    '--norc',
    'mongodb://127.0.0.1:27017/admin',
    '--eval',
    code,
  ]);

/** Changes a user's password, logged in as `user` with `auth`. `db` holds the user. */
export async function mongoSetPassword({ container, user, auth, target, db, value }) {
  const code = [
    "db.getSiblingDB('admin').auth(process.env.KATIP_USER, process.env.KATIP_AUTH);",
    'db.getSiblingDB(process.env.KATIP_DB)',
    '  .changeUserPassword(process.env.KATIP_TARGET, process.env.KATIP_VALUE);',
    "print('changed');",
  ].join('\n');
  const { code: exit, out } = await mongosh(
    container,
    {
      KATIP_USER: user,
      KATIP_AUTH: auth,
      KATIP_TARGET: target,
      KATIP_DB: db,
      KATIP_VALUE: value,
    },
    code,
  );
  if (exit !== 0 || !out.includes('changed')) {
    throw failed(`changing the Mongo password of ${target}`, container, out, [value, auth]);
  }
}

export async function mongoCanLogin({ container, user, db, value }) {
  const code = [
    'db.getSiblingDB(process.env.KATIP_DB).auth(process.env.KATIP_USER, process.env.KATIP_VALUE);',
    "print('accepted');",
  ].join('\n');
  const { code: exit, out } = await mongosh(
    container,
    { KATIP_DB: db, KATIP_USER: user, KATIP_VALUE: value },
    code,
  );
  return exit === 0 && out.includes('accepted');
}

// ---- the stores a rotation can use ------------------------------------------------------------

/**
 * Each store has set(target, { auth, value }), where `auth` is the value it holds now, and
 * verify(target, value): true or false, or null where a value can't be tried from here.
 * A target is { recipe, slug }.
 *
 * `containers.postgres()`, `.mongo()` and `.ragdb(slug)` name containers; `platformEnv()` reads
 * katip.env; `keycloak(action, env)` runs secret-kc.mjs and returns its output;
 * `setGatewayKey(slug, value)` stores a key's hash through the provisioner.
 */
export function realStores({ containers, platformEnv, keycloak, setGatewayKey }) {
  const pgOf = ({ recipe, slug }) => {
    const { role, db } = recipe.store;
    if (recipe.store.where === 'ragdb') {
      return { container: containers.ragdb(slug), admin: role, role, db };
    }
    const admin = platformEnv().POSTGRES_USER;
    return { container: containers.postgres(), admin, role: role ?? admin, db };
  };
  const clientOf = ({ recipe, slug }) => recipe.store.clientId ?? `lc-${slug}`;
  const accepted = async (action, env) => {
    try {
      return (await keycloak(action, env)).includes('result=valid');
    } catch {
      return false;
    }
  };

  return {
    pg: {
      set: (t, { value }) => pgSetPassword({ ...pgOf(t), value }),
      verify: (t, value) => pgCanLogin({ ...pgOf(t), value }),
    },
    'mongo-root': {
      set: (t, { auth, value }) => {
        const user = platformEnv().MONGO_USER;
        return mongoSetPassword({
          container: containers.mongo(),
          user,
          auth,
          target: user,
          db: 'admin',
          value,
        });
      },
      verify: (t, value) =>
        mongoCanLogin({
          container: containers.mongo(),
          user: platformEnv().MONGO_USER,
          db: 'admin',
          value,
        }),
    },
    // A company's login, changed by the root user: its own login can't change itself.
    'mongo-tenant': {
      set: ({ slug }, { value }) =>
        mongoSetPassword({
          container: containers.mongo(),
          user: platformEnv().MONGO_USER,
          auth: platformEnv().MONGO_PASSWORD,
          target: `lc_${slug}`,
          db: `lc_${slug}`,
          value,
        }),
      verify: ({ slug }, value) =>
        mongoCanLogin({
          container: containers.mongo(),
          user: `lc_${slug}`,
          db: `lc_${slug}`,
          value,
        }),
    },
    'kc-client': {
      set: async (t, { value }) => {
        await keycloak('set-client-secret', { KC_CLIENT_ID: clientOf(t), KC_VALUE: value });
      },
      verify: (t, value) =>
        accepted('check-client-secret', { KC_CLIENT_ID: clientOf(t), KC_VALUE: value }),
    },
    'kc-admin': {
      set: async (t, { auth, value }) => {
        await keycloak('set-admin-password', { KC_ADMIN_PASSWORD: auth, KC_VALUE: value });
      },
      verify: (t, value) => accepted('check-admin-password', { KC_VALUE: value }),
    },
    // Dev only. These users' logins want MFA, so a password can't be tried from here.
    'kc-demo-users': {
      set: async ({ slug }, { value }) => {
        await keycloak('set-user-passwords', {
          KC_EMAILS: JSON.stringify(
            ['admin', 'manager', 'user'].map((who) => `${who}@${slug}.localhost`),
          ),
          KC_VALUE: value,
        });
      },
      verify: async () => null,
    },
    // The governance database holds only a hash, and the gateway's smoke check tries the key.
    'gateway-key': {
      set: ({ slug }, { value }) => setGatewayKey(slug, value),
      verify: async () => null,
    },
  };
}
