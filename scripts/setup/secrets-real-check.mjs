#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// pnpm test:secrets-real: the real rotation commands, against throwaway containers on a private
// network of their own, from the images pinned in katip.config.yaml. It never touches the stack,
// needs no env file, and removes what it starts. Every value here is made up on the spot.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { curlKeyConfig } from './steps.mjs';
import {
  abort,
  fileJournal,
  generateValue,
  resume,
  rotate,
  updateEnvFile,
} from './secret-rotation.mjs';
import {
  execIn,
  mongoCanLogin,
  mongoSetPassword,
  pgCanLogin,
  pgSetPassword,
  realStores,
} from './secret-stores.mjs';
import { ROOT, parseEnvFile, run, tryRun } from './util.mjs';

const { images } = loadConfig();
const NODE_IMAGE = 'node:22.23.1-alpine'; // the one local-llm-relay already pins
const id = randomBytes(4).toString('hex');
const NETWORK = `ksr-${id}-net`;
const name = (what) => `ksr-${id}-${what}`;

/** Everything that quoting tends to get wrong, all at once. */
const AWKWARD = `p'a"s$w\\o rd%@:/?#&;!\`x{}[]$(id)-${id}`;

const started = [];
const volumes = [];
const shownValues = new Set([AWKWARD]);
let passed = 0;
const failures = [];

function check(what, ok) {
  if (ok) {
    passed++;
    console.log(`  ok    ${what}`);
  } else {
    failures.push(what);
    console.log(`  FAIL  ${what}`);
  }
}

const made = (key = 'X_PASSWORD') => {
  const value = generateValue(key);
  shownValues.add(value);
  return value;
};

async function start(what, image, env, args = []) {
  const container = name(what);
  await tryRun(
    'docker',
    [
      'run',
      '-d',
      '--name',
      container,
      '--network',
      NETWORK,
      '--network-alias',
      what,
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      ...args.slice(
        0,
        args.indexOf('--image-args') === -1 ? args.length : args.indexOf('--image-args'),
      ),
      image,
      ...(args.includes('--image-args') ? args.slice(args.indexOf('--image-args') + 1) : []),
    ],
    { env },
  );
  if (!started.includes(container)) started.push(container);
  return container;
}

const remove = (container) => run('docker', ['rm', '-f', container]);

async function waitFor(what, fn, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not come up within ${timeoutMs / 1000} s`);
}

/** Runs node on the private network, with its code on stdin and its values in its environment. */
function nodeOnNetwork(code, env, mounts = []) {
  return run(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--network',
      NETWORK,
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      ...mounts.flatMap((m) => ['-v', m]),
      NODE_IMAGE,
      '--input-type=module',
    ],
    { env, input: code, timeoutMs: 120_000 },
  );
}

/** As the services do: a URL, from a different container, in its environment. */
const pgUrlConnects = (url) =>
  run(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      NETWORK,
      '-e',
      'KATIP_URL',
      images.postgres,
      'sh',
      '-c',
      'psql "$KATIP_URL" -w -Atc "select 1"',
    ],
    { env: { KATIP_URL: url }, timeoutMs: 60_000 },
  ).then((r) => r.code === 0 && r.out.trim() === '1');

const mongoUrlConnects = (url) =>
  run(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      NETWORK,
      '-e',
      'KATIP_URL',
      images.mongodb,
      'sh',
      '-c',
      'mongosh "$KATIP_URL" --quiet --norc --eval "db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers.length"',
    ],
    { env: { KATIP_URL: url }, timeoutMs: 60_000 },
  ).then((r) => r.code === 0 && r.out.trim() === '1');

/** What a throwaway container's own log holds must not include any value of ours. */
async function logsAreClean(container) {
  const { out } = await run('docker', ['logs', container]);
  return ![...shownValues].some((v) => out.includes(v));
}

// ---- Postgres ---------------------------------------------------------------------------------

async function postgres() {
  console.log('Postgres');
  const admin = 'katip';
  const initial = made();
  const c = await start('postgres', images.postgres, {
    POSTGRES_USER: admin,
    POSTGRES_PASSWORD: initial,
    POSTGRES_DB: 'governance',
  });
  // The image starts a temporary server first, on the socket only: wait for the real one.
  await waitFor('postgres', () =>
    pgCanLogin({ container: c, role: admin, db: 'governance', value: initial }),
  );
  const psql = (sql) => execIn(c, {}, ['psql', '-X', '-U', admin, '-d', 'governance', '-c', sql]);
  await psql('CREATE ROLE rotate_me LOGIN');
  const db = { container: c, admin, role: 'rotate_me', db: 'governance' };

  await pgSetPassword({ ...db, value: AWKWARD });
  check('ALTER ROLE takes a password with quotes, $, \\, spaces and %', true);
  check('it logs in with exactly that password', await pgCanLogin({ ...db, value: AWKWARD }));
  check(
    'a wrong password is refused, so the check means something',
    !(await pgCanLogin({ ...db, value: `${AWKWARD}x` })),
  );
  check(
    'a password of only one quote works too',
    await (async () => {
      const value = `'`;
      await pgSetPassword({ ...db, value });
      return pgCanLogin({ ...db, value });
    })(),
  );

  const generated = made('KC_DB_PASSWORD');
  const previous = made('KC_DB_PASSWORD');
  await pgSetPassword({ ...db, value: previous });
  await pgSetPassword({ ...db, value: generated });
  const url = (p) => `postgres://rotate_me:${p}@postgres:5432/governance`;
  check(
    'a service connects with the new generated value, by URL',
    await pgUrlConnects(url(generated)),
  );
  check('the previous value no longer connects', !(await pgUrlConnects(url(previous))));

  await pgSetPassword({ ...db, role: admin, value: generated });
  check(
    'the admin role rotates too, over its socket',
    await pgCanLogin({ ...db, role: admin, value: generated }),
  );
  check(
    'and its old password stops working',
    !(await pgCanLogin({ ...db, role: admin, value: initial })),
  );

  const refused = await pgSetPassword({ ...db, role: 'no_such_role', value: AWKWARD }).catch(
    (e) => e,
  );
  check('ALTER ROLE on a missing role fails', refused instanceof Error);
  check('that failure message does not hold the value', !refused.message.includes(AWKWARD));
  check('and it says what went wrong', refused.message.includes('no_such_role'));
  check("the server's log holds no value, even from the failure", await logsAreClean(c));
  return c;
}

// ---- Mongo ------------------------------------------------------------------------------------

async function mongo() {
  console.log('Mongo');
  const user = 'katip';
  const initial = made();
  const volume = name('mongodata');
  volumes.push(volume);
  const args = ['-v', `${volume}:/data/db`];
  let c = await start(
    'mongodb',
    images.mongodb,
    { MONGO_INITDB_ROOT_USERNAME: user, MONGO_INITDB_ROOT_PASSWORD: initial },
    args,
  );
  await waitFor('mongo', () => mongoCanLogin({ container: c, user, db: 'admin', value: initial }));
  const root = { container: c, user, db: 'admin' };

  // A company's login and some of its data, as the provisioner makes them.
  const tenantPassword = made();
  const seed = await execIn(
    c,
    { KATIP_USER: user, KATIP_AUTH: initial, KATIP_VALUE: tenantPassword },
    [
      'mongosh',
      '--quiet',
      '--norc',
      'mongodb://127.0.0.1:27017/admin',
      '--eval',
      `db.getSiblingDB('admin').auth(process.env.KATIP_USER, process.env.KATIP_AUTH);
       const t = db.getSiblingDB('lc_acme');
       t.createUser({ user: 'lc_acme', pwd: process.env.KATIP_VALUE, roles: [{ role: 'readWrite', db: 'lc_acme' }] });
       t.chats.insertOne({ title: 'kept' });`,
    ],
  );
  check('a company login and data are set up', seed.code === 0);

  await mongoSetPassword({ ...root, auth: initial, target: user, value: AWKWARD });
  check('changeUserPassword takes a password with quotes, $, \\ and spaces', true);
  check(
    'the root user logs in with exactly that',
    await mongoCanLogin({ ...root, value: AWKWARD }),
  );
  check('its old password is refused', !(await mongoCanLogin({ ...root, value: initial })));

  const generated = made('MONGO_PASSWORD');
  await mongoSetPassword({ ...root, auth: AWKWARD, target: user, value: generated });
  const rootUrl = (p) => `mongodb://${user}:${p}@mongodb:27017/?authSource=admin`;
  check(
    'a service connects with the new generated value, by URL',
    await mongoUrlConnects(rootUrl(generated)),
  );
  check(
    'the previous value no longer connects',
    !(await mongoUrlConnects(rootUrl(encodeURIComponent(AWKWARD)))),
  );

  const wrong = await mongoSetPassword({
    ...root,
    auth: 'not-the-password-at-all',
    target: user,
    value: AWKWARD,
  }).catch((e) => e);
  check('a change with the wrong current password fails', wrong instanceof Error);
  check('that failure message does not hold a value', !wrong.message.includes(AWKWARD));
  check('and nothing changed', await mongoCanLogin({ ...root, value: generated }));

  const newTenant = made('KATIP_T_ACME_MONGO_PASSWORD');
  await mongoSetPassword({
    ...root,
    auth: generated,
    target: 'lc_acme',
    db: 'lc_acme',
    value: newTenant,
  });
  const tenantUrl = (p) => `mongodb://lc_acme:${p}@mongodb:27017/lc_acme?authSource=lc_acme`;
  check(
    "a company's login rotates, and LibreChat's form of URL connects",
    await mongoUrlConnects(tenantUrl(newTenant)),
  );
  check(
    "that company's old password no longer connects",
    !(await mongoUrlConnects(tenantUrl(tenantPassword))),
  );

  // As compose does on a rotation: the same data, a new container, the new value in its env.
  check("Mongo's log holds no value", await logsAreClean(c));
  await remove(c);
  c = await start(
    'mongodb',
    images.mongodb,
    { MONGO_INITDB_ROOT_USERNAME: user, MONGO_INITDB_ROOT_PASSWORD: generated },
    args,
  );
  await waitFor('mongo again', () =>
    mongoCanLogin({ container: c, user, db: 'admin', value: generated }),
  );
  check('after a recreate on the same volume, the rotated password still works', true);
  check(
    "after a recreate, the company's login still works",
    await mongoCanLogin({ container: c, user: 'lc_acme', db: 'lc_acme', value: newTenant }),
  );
  const kept = await execIn(c, { KATIP_VALUE: newTenant }, [
    'mongosh',
    '--quiet',
    '--norc',
    'mongodb://127.0.0.1:27017/lc_acme',
    '--eval',
    "db.auth('lc_acme', process.env.KATIP_VALUE); print(db.chats.countDocuments({ title: 'kept' }))",
  ]);
  check("and the company's chats are still there", kept.out.trim().endsWith('1'));
  return { container: c, password: generated };
}

// ---- Meilisearch ------------------------------------------------------------------------------

async function meilisearch() {
  console.log('Meilisearch');
  const oldKey = made();
  const newKey = made('KATIP_T_ACME_MEILI_KEY');
  const volume = name('meili');
  volumes.push(volume);
  const args = ['-v', `${volume}:/meili_data`];
  const env = (key) => ({
    MEILI_MASTER_KEY: key,
    MEILI_ENV: 'development',
    MEILI_NO_ANALYTICS: 'true',
  });
  const call = (key, path, body) =>
    nodeOnNetwork(
      `const r = await fetch('http://meili:7700${path}', {
         method: ${body ? "'POST'" : "'GET'"},
         headers: { authorization: 'Bearer ' + process.env.KEY, 'content-type': 'application/json' },
         ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
       });
       console.log(r.status, JSON.stringify(await r.json()));`,
      { KEY: key },
    ).then((r) => r.out.trim());

  let c = await start('meili', images.meilisearch, env(oldKey), args);
  await waitFor('meilisearch', async () => (await call(oldKey, '/health')).startsWith('200'));
  await call(oldKey, '/indexes/convos/documents', [{ id: 1, title: 'kept across a key change' }]);
  await waitFor('its index', async () =>
    (await call(oldKey, '/indexes/convos/search?q=kept')).includes('kept across'),
  );
  await remove(c);

  c = await start('meili', images.meilisearch, env(newKey), args);
  await waitFor('meilisearch again', async () => (await call(newKey, '/health')).startsWith('200'));
  const found = await call(newKey, '/indexes/convos/search?q=kept');
  check(
    'the new master key works on the existing data, which is still there',
    found.startsWith('200') && found.includes('kept across'),
  );
  check('the old master key is refused', (await call(oldKey, '/indexes')).startsWith('403'));
  check('its log holds no value', await logsAreClean(c));
  await remove(c);
}

// ---- Keycloak ---------------------------------------------------------------------------------

async function keycloak() {
  console.log('Keycloak');
  const admin = 'katip-admin';
  const initial = made();
  const c = await start(
    'keycloak',
    images.keycloak,
    {
      KC_BOOTSTRAP_ADMIN_USERNAME: admin,
      KC_BOOTSTRAP_ADMIN_PASSWORD: initial,
      KC_CACHE: 'local',
    },
    ['--image-args', 'start-dev', '--http-port=8080'],
  );
  const setup = join(ROOT, 'scripts', 'setup');
  const mount = [`${setup}:/setup:ro`];
  const script = (action, env) =>
    nodeOnNetwork(
      "await import('/setup/secret-kc.mjs');",
      {
        KC_URL: 'http://keycloak:8080',
        KC_REALM: 'katip',
        KC_ADMIN_USER: admin,
        KC_ACTION: action,
        ...env,
      },
      mount,
    );
  const valid = async (action, env) => (await script(action, env)).out.includes('result=valid');

  await waitFor('keycloak', () => valid('check-admin-password', { KC_VALUE: initial }), 240_000);
  const firstClient = made();
  const firstLogin = made();
  const firstUser = made();
  const fixture = await nodeOnNetwork(
    `import { adminClient, findClient } from '/setup/kc-lib.mjs';
     const api = await adminClient('http://keycloak:8080', process.env.U, process.env.P);
     await api('POST', '/realms', { realm: 'katip', enabled: true });
     const R = '/realms/katip';
     await api('POST', R + '/clients', { clientId: 'katip-provisioner', publicClient: false, secret: process.env.A, serviceAccountsEnabled: true, standardFlowEnabled: false });
     await api('POST', R + '/clients', { clientId: 'lc-acme', publicClient: false, secret: process.env.B, standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: ['https://acme/*'] });
     await api('POST', R + '/clients', { clientId: 'password-test', publicClient: true, directAccessGrantsEnabled: true });
     for (const email of ['user@acme.localhost', 'admin@acme.localhost']) {
       await api('POST', R + '/users', { username: email, email, firstName: 'A', lastName: 'B', enabled: true, emailVerified: true, credentials: [{ type: 'password', value: process.env.C, temporary: false }] });
     }
     console.log('fixture ready');`,
    { U: admin, P: initial, A: firstClient, B: firstLogin, C: firstUser },
    mount,
  );
  if (!fixture.out.includes('fixture ready')) {
    throw new Error('could not set up the Keycloak fixture');
  }
  const adminEnv = (password) => ({ KC_ADMIN_PASSWORD: password });

  const service = { KC_CLIENT_ID: 'katip-provisioner' };
  const next = made('KATIP_PROVISIONER_KC_SECRET');
  const changed = await script('set-client-secret', {
    ...adminEnv(initial),
    ...service,
    KC_VALUE: next,
  });
  check('a client secret changes', changed.code === 0);
  check(
    'the service account logs in with the new secret',
    await valid('check-client-secret', { ...service, KC_VALUE: next }),
  );
  check(
    'and not the old one',
    !(await valid('check-client-secret', { ...service, KC_VALUE: firstClient })),
  );

  const login = { KC_CLIENT_ID: 'lc-acme' };
  const nextLogin = made('KATIP_T_ACME_LC_OIDC_CLIENT_SECRET');
  await script('set-client-secret', { ...adminEnv(initial), ...login, KC_VALUE: nextLogin });
  check(
    "a company's login client passes with the new secret",
    await valid('check-client-secret', { ...login, KC_VALUE: nextLogin }),
  );
  check(
    'and not the old one, so a login client can be told apart',
    !(await valid('check-client-secret', { ...login, KC_VALUE: firstLogin })),
  );

  const nextUser = made('KATIP_T_ACME_DEMO_USER_PASSWORD');
  await script('set-user-passwords', {
    ...adminEnv(initial),
    KC_EMAILS: JSON.stringify(['user@acme.localhost', 'nobody@acme.localhost']),
    KC_VALUE: nextUser,
  });
  const userLogin = (password) =>
    nodeOnNetwork(
      `const r = await fetch('http://keycloak:8080/realms/katip/protocol/openid-connect/token', {
         method: 'POST',
         body: new URLSearchParams({ grant_type: 'password', client_id: 'password-test', username: 'user@acme.localhost', password: process.env.P }),
       });
       console.log(r.status);`,
      { P: password },
    ).then((r) => r.out.trim());
  check(
    'a demo user logs in with the new password, and a missing one is skipped',
    (await userLogin(nextUser)) === '200',
  );
  check('and not the old one', (await userLogin(firstUser)) === '400');

  const changedAdmin = await script('set-admin-password', {
    ...adminEnv(initial),
    KC_VALUE: AWKWARD,
  });
  check('the admin password changes, to one with awkward characters', changedAdmin.code === 0);
  check('the admin logs in with it', await valid('check-admin-password', { KC_VALUE: AWKWARD }));
  check('and not the old one', !(await valid('check-admin-password', { KC_VALUE: initial })));
  const failed = await script('set-admin-password', {
    ...adminEnv('not-the-password-any-more'),
    KC_VALUE: AWKWARD,
  });
  check('a change with the wrong admin password fails', failed.code !== 0);
  check('and its output holds no value', ![...shownValues].some((v) => failed.out.includes(v)));
  check("Keycloak's log holds no value", await logsAreClean(c));
  await remove(c);
}

// ---- the key in the smoke check ---------------------------------------------------------------

/** gatewayStatus's way of sending a key: curl's config on stdin, against a server that shows it. */
async function curlKey() {
  console.log('curl');
  const key = made('KATIP_T_ACME_GATEWAY_KEY');
  const withKey = await start('echo', NODE_IMAGE, { WANT: key }, [
    '--image-args',
    '-e',
    "require('http').createServer((q,s)=>{s.statusCode=q.headers.authorization==='Bearer '+process.env.WANT?200:401;s.end()}).listen(8080)",
  ]);
  const ask = (input) =>
    run(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        NETWORK,
        images.curl,
        '-sS',
        '-m',
        '10',
        '--retry',
        '10',
        '--retry-connrefused',
        '--retry-delay',
        '1',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-K',
        '-',
        'http://echo:8080/',
      ],
      { input, timeoutMs: 60_000 },
    ).then((r) => r.out.trim());
  check('curl sends a key given on its stdin', (await ask(curlKeyConfig(key))) === '200');
  check('and the server can tell a wrong one', (await ask(curlKeyConfig(`${key}x`))) === '401');
  await remove(withKey);
}

// ---- the whole flow, on real stores -----------------------------------------------------------

/** rotate() and its order on real commands: a failure, a resume, an abort, real env files. */
async function wholeFlow(pgContainer, mongoState) {
  console.log('The whole flow, with a pretend restart');
  const dir = mkdtempSync(join(tmpdir(), 'katip-secrets-real-'));
  try {
    const psql = (sql) =>
      execIn(pgContainer, {}, ['psql', '-X', '-U', 'katip', '-d', 'governance', '-c', sql]);
    await psql('CREATE ROLE keycloak LOGIN');
    await psql('CREATE DATABASE keycloak OWNER keycloak');
    const oldPg = made('KC_DB_PASSWORD');
    await pgSetPassword({
      container: pgContainer,
      admin: 'katip',
      role: 'keycloak',
      db: 'governance',
      value: oldPg,
    });
    const envFile = join(dir, 'katip.env');
    writeFileSync(
      envFile,
      `# a comment\nPOSTGRES_USER=katip\nKC_DB_PASSWORD=${oldPg}\nMONGO_USER=katip\nMONGO_PASSWORD=${mongoState.password}\n`,
      { mode: 0o644 },
    );
    const readEnv = () => parseEnvFile(readFileSync(envFile, 'utf8'));
    const journalPath = join(dir, 'rotation-pending.env');
    let restartFails = 0;
    const rotations = {};
    const deps = {
      stores: realStores({
        containers: {
          postgres: () => pgContainer,
          mongo: () => mongoState.container,
          ragdb: () => pgContainer,
        },
        platformEnv: readEnv,
        keycloak: async () => '',
        setGatewayKey: async () => {},
      }),
      journal: fileJournal(journalPath),
      rotations: { record: (key, date) => (rotations[key] = date) },
      now: () => new Date(),
      log: () => {},
      readEnv,
      writeEnv: (slug, updates) => updateEnvFile(envFile, updates),
      confirm: async () => true,
      preflight: async () => {},
      restart: async () => {
        if (restartFails-- > 0) throw new Error('the restart failed');
      },
      check: async () => {},
    };
    const pgRole = (value) =>
      pgCanLogin({ container: pgContainer, role: 'keycloak', db: 'keycloak', value });
    const mongoRoot = (value) =>
      mongoCanLogin({ container: mongoState.container, user: 'katip', db: 'admin', value });

    await rotate({ name: 'KC_DB_PASSWORD' }, deps);
    const rotated = readEnv().KC_DB_PASSWORD;
    shownValues.add(rotated);
    check('a Postgres role rotates, end to end', rotated !== oldPg && (await pgRole(rotated)));
    check('and its old password stops working', !(await pgRole(oldPg)));
    check('the env file stays mode 600', (statSync(envFile).mode & 0o777) === 0o600);
    check(
      'and its other lines are unchanged',
      readFileSync(envFile, 'utf8').startsWith('# a comment\nPOSTGRES_USER=katip\n'),
    );
    check('no rotation is left open', !existsSync(journalPath));
    check('it is on the record', Boolean(rotations.KC_DB_PASSWORD));

    restartFails = 1;
    const stopped = await rotate({ name: 'KC_DB_PASSWORD' }, deps).catch((e) => e);
    const midway = readEnv().KC_DB_PASSWORD;
    shownValues.add(midway);
    check(
      'a failed restart says how to finish',
      /--resume/.test(stopped.message) && /--abort/.test(stopped.message),
    );
    check('its message holds no value', ![...shownValues].some((v) => stopped.message.includes(v)));
    check('the new value is in use by then', await pgRole(midway));
    check('the journal is mode 600', (statSync(journalPath).mode & 0o777) === 0o600);
    await resume(deps);
    check('--resume finishes it', !existsSync(journalPath) && (await pgRole(midway)));

    restartFails = 1;
    await rotate({ name: 'KC_DB_PASSWORD' }, deps).catch(() => {});
    shownValues.add(readEnv().KC_DB_PASSWORD);
    await abort(deps);
    check('--abort puts the old value back in Postgres', await pgRole(midway));
    check('and in the file', readEnv().KC_DB_PASSWORD === midway);

    const oldMongo = mongoState.password;
    await rotate({ name: 'MONGO_PASSWORD' }, deps);
    const newMongo = readEnv().MONGO_PASSWORD;
    shownValues.add(newMongo);
    check('the Mongo root password rotates, end to end', await mongoRoot(newMongo));
    check('and its old one stops working', !(await mongoRoot(oldMongo)));

    restartFails = 1;
    await rotate({ name: 'MONGO_PASSWORD' }, deps).catch(() => {});
    shownValues.add(readEnv().MONGO_PASSWORD);
    await abort(deps);
    check(
      '--abort puts Mongo back, logging in with the new one to do so',
      await mongoRoot(newMongo),
    );

    // Nothing accepts this, so the store is out of step with the file.
    const out = readFileSync(envFile, 'utf8').replace(
      `KC_DB_PASSWORD=${midway}`,
      'KC_DB_PASSWORD=this-is-not-what-postgres-holds-at-all',
    );
    writeFileSync(envFile, out);
    const refused = await rotate({ name: 'KC_DB_PASSWORD' }, deps).catch((e) => e);
    check('a store already out of step is refused', /out of step/.test(refused.message));
    check('and what it holds is not touched', await pgRole(midway));
    check(
      "the servers' logs hold no value",
      (await logsAreClean(pgContainer)) && (await logsAreClean(mongoState.container)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- running it -------------------------------------------------------------------------------

async function main() {
  await tryRun('docker', ['network', 'create', NETWORK]);
  await curlKey();
  const pg = await postgres();
  const mongoState = await mongo();
  await wholeFlow(pg, mongoState);
  await remove(pg);
  await remove(mongoState.container);
  await meilisearch();
  await keycloak();
}

try {
  await main();
} catch (e) {
  failures.push(`stopped early: ${e.message}`);
} finally {
  for (const c of started) await remove(c);
  for (const v of volumes) await run('docker', ['volume', 'rm', '-f', v]);
  await run('docker', ['network', 'rm', NETWORK]);
}

const leftover = (await run('docker', ['ps', '-aq', '--filter', `name=ksr-${id}`])).out.trim();
if (leftover) failures.push('a container was left behind');

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) {
  let shown = f;
  for (const v of shownValues) shown = shown.replaceAll(v, '***');
  console.log(`  ${shown}`);
}
process.exitCode = failures.length > 0 ? 1 : 0;
