// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import {
  assessData,
  decideRollback,
  describeData,
  destroyDataFlag,
  leftovers,
  readSnapshot,
  runRollback,
  seededEmails,
  teardown,
} from '../rollback-guard.mjs';

const config = {
  project: { name: 'katip', base_domain: 'localhost' },
  identity: { realm: 'katip' },
  tenants: [
    { slug: 'demo', name: 'Demo A.Ş.', admin_email: 'owner@demo.localhost' },
    { slug: 'acme', name: 'Acme Ltd.', admin_email: 'it@acme.com.tr' },
  ],
};

const row = (slug, emails, status = 'active') => ({
  slug,
  status,
  users: emails.map((email) => ({ email, status: 'active' })),
});
const db = (slug, accounts = [], chatOwners = [], chats = chatOwners.length) => ({
  db: `lc_${slug}`,
  users: accounts.map((email, i) => ({ id: `id${i}`, email })),
  chats,
  chatOwners,
});
const demoOnly = () => ({
  volumes: ['katip_pgdata', 'katip_mongodata', 'katip-demo_meili-demo'],
  governance: [
    row('demo', ['demo@example.com', 'admin@demo.localhost', 'smoke-member@demo.localhost']),
  ],
  mongo: [db('demo', ['smoke-member@demo.localhost'], ['id0'], 4)],
  hostSlugs: ['demo'],
});

describe('seededEmails', () => {
  it('holds what the bootstrap creates', () => {
    const seeded = seededEmails(config, config.tenants[0]);
    for (const email of [
      'demo@example.com',
      'smoke-member@demo.localhost',
      'admin@demo.localhost',
      'manager@demo.localhost',
      'user@demo.localhost',
      'owner@demo.localhost',
    ]) {
      expect(seeded.has(email)).toBe(true);
    }
  });

  it("doesn't count an admin email at a real domain as seeded", () => {
    expect(seededEmails(config, config.tenants[1]).has('it@acme.com.tr')).toBe(false);
  });
});

describe('assessData', () => {
  it('is demo with listed companies and only seeded users', () => {
    const a = assessData(demoOnly(), config);
    expect(a.verdict).toBe('demo');
    expect(a.reasons).toEqual([]);
  });

  it('is real when a Turkish user is in a listed company', () => {
    const s = demoOnly();
    s.governance[0].users.push({ email: 'ayşe@şirket.com.tr', status: 'active' });
    const a = assessData(s, config);
    expect(a.verdict).toBe('real');
    expect(a.reasons[0]).toContain('demo: 1 user(s)');
  });

  it('is real when the real admin from the config has signed in', () => {
    const s = demoOnly();
    s.governance.push(row('acme', ['it@acme.com.tr']));
    expect(assessData(s, config).verdict).toBe('real');
  });

  it('is real for a company not listed in the config, even with no users', () => {
    const s = demoOnly();
    s.governance.push(row('newco', []));
    const a = assessData(s, config);
    expect(a.verdict).toBe('real');
    expect(a.reasons[0]).toContain('newco: not listed');
  });

  it('is real for a Mongo database nobody knows about', () => {
    const s = demoOnly();
    s.mongo.push(db('ghost'));
    expect(assessData(s, config).verdict).toBe('real');
  });

  it('is real for a secrets file of an unlisted company', () => {
    const s = demoOnly();
    s.hostSlugs.push('other');
    expect(assessData(s, config).verdict).toBe('real');
  });

  it('is real for a LibreChat account not seeded', () => {
    const s = demoOnly();
    s.mongo[0].users.push({ id: 'x', email: 'real@acme.com.tr' });
    expect(assessData(s, config).verdict).toBe('real');
  });

  it('is real for a chat owned by someone without a seeded account', () => {
    const s = demoOnly();
    s.mongo[0].chatOwners.push('someone-else');
    expect(assessData(s, config).verdict).toBe('real');
  });

  it('is real when the governance database cannot be read, and says so', () => {
    const a = assessData({ ...demoOnly(), governance: null }, config);
    expect(a.verdict).toBe('real');
    expect(a.unreadable).toContain('could not read the governance database');
    expect(describeData(a, 'katip').join('\n')).toContain('treating this as real data');
  });

  it('is real when Mongo cannot be read', () => {
    expect(assessData({ ...demoOnly(), mongo: null }, config).verdict).toBe('real');
  });

  it('is real when Docker cannot be asked', () => {
    const a = assessData({ volumes: null, governance: null, mongo: null, hostSlugs: [] }, config);
    expect(a.verdict).toBe('real');
  });

  it('is real on a base domain that is not a .localhost one', () => {
    const real = { ...config, project: { name: 'katip', base_domain: 'katip.com.tr' } };
    expect(assessData(demoOnly(), real).verdict).toBe('real');
  });

  it('is empty when no data volume exists, as on an install stopped at the start', () => {
    const a = assessData(
      { volumes: ['katip_valkey'], governance: null, mongo: null, hostSlugs: ['demo'] },
      config,
    );
    expect(a.verdict).toBe('empty');
  });

  it('is empty when the database has no schema yet and Mongo no companies', () => {
    const a = assessData(
      { volumes: ['katip_pgdata'], governance: [], mongo: [], hostSlugs: [] },
      config,
    );
    expect(a.verdict).toBe('empty');
  });

  it('still says real on a stopped stack: no volumes gone, nothing readable', () => {
    const a = assessData(
      { volumes: ['katip_pgdata'], governance: null, mongo: null, hostSlugs: ['demo'] },
      config,
    );
    expect(a.verdict).toBe('real');
  });

  describe('a purged company', () => {
    const purged = {
      slug: 'e2e-abc123',
      status: 'deleted',
      users: [{ email: 'deleted-1@deleted.invalid', status: 'disabled' }],
    };

    it("doesn't count: the e2e tests leave these on a demo stack", () => {
      const s = demoOnly();
      s.governance.push(purged);
      const a = assessData(s, config);
      expect(a.verdict).toBe('demo');
      expect(a.companies.find((c) => c.slug === purged.slug).status).toBe('purged');
    });

    it('counts while its data remains: deleted, but not yet purged', () => {
      const s = demoOnly();
      s.governance.push(purged);
      s.mongo.push(db(purged.slug));
      expect(assessData(s, config).verdict).toBe('real');
    });

    it('counts while its secrets remain', () => {
      const s = demoOnly();
      s.governance.push(purged);
      s.hostSlugs.push(purged.slug);
      expect(assessData(s, config).verdict).toBe('real');
    });

    it('counts while a user still has a real address', () => {
      const s = demoOnly();
      s.governance.push({ ...purged, users: [{ email: 'a@b.com', status: 'disabled' }] });
      expect(assessData(s, config).verdict).toBe('real');
    });

    it('counts when Mongo could not be read, so its data may remain', () => {
      const s = { ...demoOnly(), mongo: null };
      s.governance.push(purged);
      expect(assessData(s, config).companies.find((c) => c.slug === purged.slug).why).toEqual([
        'not listed in katip.config.yaml',
      ]);
    });
  });
});

describe('describeData', () => {
  it('lists each company by slug, with users and chats, and no email', () => {
    const s = demoOnly();
    s.governance[0].users.push({ email: 'ayse@acme.com.tr', status: 'active' });
    const text = describeData(assessData(s, config), 'katip').join('\n');
    expect(text).toMatch(/demo\s+active\s+users: 4, LibreChat accounts: 1, chats: 4/);
    expect(text).toContain('REAL');
    expect(text).not.toContain('@');
  });
});

describe('decideRollback', () => {
  const base = { project: 'katip', interactive: false, yes: false };

  it('lets --yes through on demo data, as CI-style flows need', () => {
    expect(decideRollback({ ...base, verdict: 'demo', yes: true }).action).toBe('proceed');
    expect(decideRollback({ ...base, verdict: 'empty', yes: true }).action).toBe('proceed');
  });

  it('asks y/N on demo data without --yes', () => {
    expect(decideRollback({ ...base, verdict: 'demo' }).action).toBe('confirm-yes');
  });

  it('refuses --yes alone on real data, and says what would do', () => {
    const d = decideRollback({ ...base, verdict: 'real', yes: true });
    expect(d.action).toBe('refuse');
    expect(d.message).toContain('--yes alone is not enough');
    expect(d.message).toContain('--destroy-data katip');
  });

  it('refuses a non-interactive run on real data', () => {
    expect(decideRollback({ ...base, verdict: 'real' }).action).toBe('refuse');
  });

  it('makes a person at a terminal type the name on real data', () => {
    const d = decideRollback({ ...base, verdict: 'real', interactive: true, yes: true });
    expect(d.action).toBe('confirm-typed');
  });

  it('accepts --destroy-data with the exact name', () => {
    const d = decideRollback({ ...base, verdict: 'real', destroyData: 'katip' });
    expect(d.action).toBe('proceed');
  });

  it.each(['KATIP', 'katip ', 'other', ''])('refuses --destroy-data %j, on any data', (value) => {
    for (const verdict of ['real', 'demo', 'empty']) {
      const d = decideRollback({ ...base, verdict, yes: true, destroyData: value });
      expect(d.action).toBe('refuse');
    }
  });
});

describe('destroyDataFlag', () => {
  it('reads both forms, and tells a missing value from a missing flag', () => {
    expect(destroyDataFlag(['rollback'])).toBeUndefined();
    expect(destroyDataFlag(['rollback', '--destroy-data', 'katip'])).toBe('katip');
    expect(destroyDataFlag(['rollback', '--destroy-data=katip'])).toBe('katip');
    expect(destroyDataFlag(['rollback', '--destroy-data'])).toBe('');
    expect(destroyDataFlag(['rollback', '--destroy-data', '--yes'])).toBe('');
  });
});

describe('readSnapshot', () => {
  const containers = { pg: 'katip-postgres-1', mongo: 'katip-mongodb-1' };
  const fakeDocker = (over = {}) =>
    vi.fn(async (args) => {
      if (args[0] === 'volume') {
        return { code: 0, out: 'katip_pgdata\nother_data\nkatip-demo_meili-demo\n' };
      }
      const script = args.join(' ');
      if (script.includes('to_regclass')) return over.schema ?? { code: 0, out: 't\n' };
      if (script.includes('json_agg')) {
        return over.tenants ?? { code: 0, out: '[{"slug":"demo","status":"active","users":[]}]\n' };
      }
      return (
        over.mongo ?? {
          code: 0,
          out: 'noise\n[{"db":"lc_demo","users":[],"chats":0,"chatOwners":[]}]\n',
        }
      );
    });

  it('reads the volumes of this project only, the companies and the chats', async () => {
    const s = await readSnapshot(fakeDocker(), 'katip', containers, ['demo']);
    expect(s.volumes).toEqual(['katip_pgdata', 'katip-demo_meili-demo']);
    expect(s.governance[0].slug).toBe('demo');
    expect(s.mongo[0].db).toBe('lc_demo');
  });

  it('marks what failed as unread, and does not throw', async () => {
    const s = await readSnapshot(
      fakeDocker({ schema: { code: 1, out: 'no such container' }, mongo: { code: 1, out: 'x' } }),
      'katip',
      containers,
      [],
    );
    expect(s.governance).toBeNull();
    expect(s.mongo).toBeNull();
  });

  it('marks unparseable output as unread', async () => {
    const s = await readSnapshot(
      fakeDocker({ mongo: { code: 0, out: 'not json' } }),
      'katip',
      containers,
      [],
    );
    expect(s.mongo).toBeNull();
  });

  it('survives Docker not being there at all', async () => {
    const docker = vi.fn(async () => {
      throw new Error('spawn docker ENOENT');
    });
    const s = await readSnapshot(docker, 'katip', containers, []);
    expect(s).toMatchObject({ volumes: null, governance: null, mongo: null });
  });

  it('treats a database with no schema as having no companies', async () => {
    const s = await readSnapshot(
      fakeDocker({ schema: { code: 0, out: 'f\n' } }),
      'katip',
      containers,
      [],
    );
    expect(s.governance).toEqual([]);
  });

  it('never puts a secret on a command line', async () => {
    const docker = fakeDocker();
    await readSnapshot(docker, 'katip', containers, []);
    const all = docker.mock.calls.map(([args]) => args.join(' ')).join('\n');
    expect(all).toContain('"$MONGO_INITDB_ROOT_PASSWORD"');
    expect(all).not.toMatch(/PASSWORD=/);
  });
});

describe('leftovers', () => {
  it('names what is still there, for this project only', async () => {
    const docker = async (args) => {
      if (args[0] === 'ps') return { code: 0, out: 'katip-demo-lc-demo-1\nunrelated\n' };
      if (args[0] === 'volume') return { code: 0, out: 'katip_pgdata\n' };
      return { code: 0, out: 'bridge\nkatip_t_demo\n' };
    };
    expect(await leftovers(docker, 'katip')).toEqual([
      'container katip-demo-lc-demo-1 is still there',
      'volume katip_pgdata is still there',
      'network katip_t_demo is still there',
    ]);
  });

  it('throws when it cannot tell', async () => {
    await expect(leftovers(async () => ({ code: 1, out: '' }), 'katip')).rejects.toThrow('docker');
  });
});

describe('teardown', () => {
  const made = (log, fails = {}) =>
    ['preflight', 'config', 'networks', 'platform', 'tenant', 'schedule'].map((id) => ({
      id,
      ...(id === 'preflight'
        ? {}
        : {
            async rollback() {
              log.push(id);
              if (fails[id]) throw new Error(`docker compose down\n${fails[id]}`);
            },
          }),
    }));

  it('runs last step first, and config last of all', async () => {
    const log = [];
    expect(await teardown(made(log), {}, async () => [])).toEqual([]);
    expect(log).toEqual(['schedule', 'tenant', 'platform', 'networks', 'config']);
  });

  it('reports a failure, carries on with the rest, and keeps the secrets', async () => {
    const log = [];
    const failures = await teardown(made(log, { tenant: 'volume in use' }), {}, async () => []);
    expect(failures[0]).toBe('tenant: volume in use');
    expect(failures.at(-1)).toContain('kept the rendered files and company secrets');
    expect(log).toContain('platform');
    expect(log).not.toContain('config');
  });

  it('counts what is left behind as a failure, however quiet the steps were', async () => {
    const log = [];
    const failures = await teardown(made(log), {}, async () => [
      'volume katip_pgdata is still there',
    ]);
    expect(failures).toContain('volume katip_pgdata is still there');
    expect(log).not.toContain('config');
  });

  it('treats not being able to check as a failure', async () => {
    const failures = await teardown(made([]), {}, async () => {
      throw new Error('docker volume failed');
    });
    expect(failures[0]).toContain('could not check what is left');
  });

  it('reports the config step failing', async () => {
    const failures = await teardown(made([], { config: 'read-only' }), {}, async () => []);
    expect(failures).toEqual(['config: read-only']);
  });
});

describe('runRollback', () => {
  const run = async (snapshot, options, answer, failures = []) => {
    const printed = [];
    const errors = [];
    const destroy = vi.fn(async () => failures);
    const ask = vi.fn(async () => answer);
    const outcome = await runRollback({
      project: 'katip',
      options,
      deps: {
        config,
        readSnapshot: async () => snapshot,
        teardown: destroy,
        ask,
        print: (l) => printed.push(l),
        printError: (l) => errors.push(l),
      },
    });
    return { outcome, printed, errors, destroy, ask };
  };
  const real = () => {
    const s = demoOnly();
    s.governance.push(row('newco', ['ayse@newco.com.tr']));
    return s;
  };

  it('shows what will be lost before deleting a demo stack with --yes', async () => {
    const r = await run(demoOnly(), { yes: true });
    expect(r.outcome).toBe('done');
    expect(r.printed.join('\n')).toContain('demo');
    expect(r.destroy).toHaveBeenCalledOnce();
    expect(r.ask).not.toHaveBeenCalled();
  });

  it('deletes nothing on real data with --yes, non-interactively', async () => {
    const r = await run(real(), { yes: true });
    expect(r.outcome).toBe('refused');
    expect(r.destroy).not.toHaveBeenCalled();
    expect(r.errors.join('\n')).toContain('--destroy-data katip');
  });

  it('deletes nothing when the database could not be read and only --yes is given', async () => {
    const r = await run({ ...demoOnly(), governance: null }, { yes: true });
    expect(r.outcome).toBe('refused');
    expect(r.destroy).not.toHaveBeenCalled();
  });

  it('deletes real data only with the exact name, typed or passed', async () => {
    expect((await run(real(), { destroyData: 'katip' })).destroy).toHaveBeenCalledOnce();
    expect((await run(real(), { interactive: true }, 'katip')).destroy).toHaveBeenCalledOnce();
    for (const typed of ['y', 'yes', 'KATIP', '', null]) {
      const r = await run(real(), { interactive: true }, typed);
      expect(r.outcome).toBe('aborted');
      expect(r.destroy).not.toHaveBeenCalled();
    }
  });

  it('asks y/N on demo data, and takes anything else as no', async () => {
    expect((await run(demoOnly(), {}, 'y')).outcome).toBe('done');
    const no = await run(demoOnly(), {}, 'n');
    expect(no.outcome).toBe('aborted');
    expect(no.destroy).not.toHaveBeenCalled();
  });

  it('refuses when standard input ends with no answer', async () => {
    const r = await run(demoOnly(), {}, null);
    expect(r.outcome).toBe('refused');
    expect(r.destroy).not.toHaveBeenCalled();
  });

  it('says failed, and what failed, rather than complete', async () => {
    const r = await run(demoOnly(), { yes: true }, null, ['platform: volume in use']);
    expect(r.outcome).toBe('failed');
    expect(r.errors.join('\n')).toContain('platform: volume in use');
    expect(r.printed.join('\n')).not.toContain('complete');
  });
});
