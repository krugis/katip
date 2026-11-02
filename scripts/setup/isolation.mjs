// SPDX-License-Identifier: AGPL-3.0-only
// Cross-tenant checks, run on every install (LLD-10): each tries to cross a boundary
// for real, with one tenant's own credentials, and fails the install if it works.
import { run } from './util.mjs';

/** Each tenant checked against the next one, so a boundary is tested in both directions. */
export const tenantPairs = (tenants) =>
  tenants.length < 2 ? [] : tenants.map((t, i) => [t, tenants[(i + 1) % tenants.length]]);

const NOT_FOR_TENANTS = [
  'valkey:6379',
  'postgres:5432',
  'litellm:4000',
  'presidio-analyzer:3000',
  'mock-llm:8080',
  'keycloak:8080',
  'mailpit:8025',
];

/**
 * @param helpers.secret (t, name) => a tenant secret
 * @param helpers.gatewayStatus (t, email) => HTTP status of a gateway call with t's key
 * @param helpers.waitForTenant (t) => resolves when t's LibreChat answers
 */
export async function checkIsolation(ctx, helpers) {
  const { secret, gatewayStatus, waitForTenant } = helpers;
  const project = ctx.config.project.name;
  const base = ctx.config.project.base_domain;
  const failures = [];
  const expect = (ok, what) => {
    if (!ok) failures.push(what);
  };
  const exec = (container, script, env = {}) =>
    run(
      'docker',
      [
        'exec',
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        `${project}-${container}-1`,
        'sh',
        '-c',
        script,
      ],
      { env, timeoutMs: 30_000 },
    );
  const lc = (t) => `${t.slug}-lc-${t.slug}`;
  const meili = (t) => `${t.slug}-meili-${t.slug}`;
  const reachable = async (from, target) => {
    const [host, port] = target.split(':');
    return (await exec(lc(from), `nc -z -w2 ${host} ${port}`)).code === 0;
  };
  const searchDocs = async (t) => {
    const { out } = await exec(
      meili(t),
      'wget -qO- --header="Authorization: Bearer $K" http://127.0.0.1:7700/stats',
      { K: secret(t, 'MEILI_KEY') },
    );
    return JSON.parse(out).indexes?.messages?.numberOfDocuments ?? 0;
  };
  const adminSql = async (sql) => {
    const { out } = await exec('postgres', `psql -U katip -d governance -At -q -c "${sql}"`);
    return out.trim();
  };
  const gatewaySql = async (sql) => {
    const { out, code } = await exec(
      'postgres',
      `PGPASSWORD="$PW" psql -h 127.0.0.1 -U katip_gateway -d governance -At -q -c "${sql}"`,
      { PW: ctx.env.KATIP_GATEWAY_DB_PASSWORD },
    );
    return code === 0 ? out.trim().split('\n') : [`psql failed: ${out.slice(0, 120)}`];
  };

  const ids = Object.fromEntries(
    (await adminSql('select slug, id from tenants')).split('\n').map((line) => line.split('|')),
  );

  for (const [a, b] of tenantPairs(ctx.config.tenants)) {
    const pair = `${a.slug} → ${b.slug}`;

    // Network: only what a tenant needs, and nothing of another tenant.
    for (const target of ['policy-gateway:8080', 'mongodb:27017', `meili-${a.slug}:7700`]) {
      expect(await reachable(a, target), `${a.slug} can't reach ${target}, which it needs`);
    }
    for (const target of [...NOT_FOR_TENANTS, `meili-${b.slug}:7700`, `lc-${b.slug}:3080`]) {
      expect(!(await reachable(a, target)), `${a.slug}'s LibreChat can reach ${target}`);
    }

    // Mongo: a's login works on its own database and not on b's.
    const mongo = (db) =>
      exec(
        'mongodb',
        `mongosh --quiet "mongodb://lc_${a.slug}:$P@127.0.0.1:27017/lc_${a.slug}?authSource=lc_${a.slug}" ` +
          `--eval 'print(db.getSiblingDB("${db}").users.countDocuments({}))'`,
        { P: secret(a, 'MONGO_PASSWORD') },
      );
    expect((await mongo(`lc_${a.slug}`)).code === 0, `${a.slug} can't use its own Mongo database`);
    expect(
      (await mongo(`lc_${b.slug}`)).code !== 0,
      `${pair}: Mongo login reads the other database`,
    );

    // Search: a's key does nothing on b's instance.
    const withKey = (t, key) =>
      exec(
        meili(t),
        'wget -q -O /dev/null --header="Authorization: Bearer $K" http://127.0.0.1:7700/stats',
        { K: key },
      );
    expect(
      (await withKey(b, secret(a, 'MEILI_KEY'))).code !== 0,
      `${pair}: search key works there`,
    );
    expect(
      (await withKey(b, secret(b, 'MEILI_KEY'))).code === 0,
      `${b.slug}: own search key fails`,
    );

    // Gateway: a's key can't act as b's user.
    const stranger = `smoke-member@${b.slug}.${base}`;
    expect(
      (await gatewayStatus(a, stranger)) === '403',
      `${pair}: the gateway accepts the other tenant's user`,
    );

    // Postgres: the gateway's role, in a's context, with no tenant filter on b.
    const seen = await gatewaySql(
      `begin; select set_config('app.tenant_id','${ids[a.slug]}',true); ` +
        `select count(*) from users where tenant_id='${ids[b.slug]}'; ` +
        `select count(*) from users; commit;`,
    );
    expect(seen.at(-2) === '0', `${pair}: gateway role reads the other tenant's users: ${seen}`);
    expect(Number(seen.at(-1)) > 0, `${a.slug}: gateway role can't read its own users: ${seen}`);

    // Secrets: never shared.
    for (const name of ['GATEWAY_KEY', 'LC_CREDS_KEY', 'LC_JWT_SECRET', 'MEILI_KEY']) {
      expect(secret(a, name) !== secret(b, name), `${pair}: ${name} is shared`);
    }
  }

  // Once per install: these aren't per pair.
  const noContext = await gatewaySql('select count(*) from users');
  expect(noContext[0] === '0', `gateway role reads users with no tenant context: ${noContext}`);
  const role = await adminSql(
    "select rolsuper or rolbypassrls from pg_roles where rolname = 'katip_gateway'",
  );
  expect(role === 'f', 'the gateway role bypasses row-level security');
  const valkey = await exec('valkey', 'unset REDISCLI_AUTH VALKEYCLI_AUTH; valkey-cli ping');
  expect(valkey.out.includes('NOAUTH'), 'Valkey answers without a password');

  // A tenant's LibreChat syncs search at startup and deletes what's missing from its own
  // database, so restart one and check the other tenant's search data is still there.
  const [first, second] = tenantPairs(ctx.config.tenants)[0] ?? [];
  if (first && second) {
    const before = await searchDocs(first);
    await run('docker', ['restart', `${project}-${lc(second)}-1`], { timeoutMs: 60_000 });
    await waitForTenant(second);
    await new Promise((r) => setTimeout(r, 5000));
    const after = await searchDocs(first);
    expect(after === before, `${second.slug}'s search sync changed ${first.slug}'s index`);
    expect(before > 0, `${first.slug} has no search data, so the sync check proves nothing`);
  }

  if (failures.length > 0) {
    throw new Error(`tenant isolation is broken:\n  - ${failures.join('\n  - ')}`);
  }
}
