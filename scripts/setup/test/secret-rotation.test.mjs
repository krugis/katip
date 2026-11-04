// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abort,
  checkSuppliedValue,
  fileJournal,
  fileRotations,
  generateValue,
  listSecrets,
  platformSecretNames,
  resume,
  rotate,
  tenantSecretNames,
  updateEnvFile,
} from '../secret-rotation.mjs';
import { realStores, scrub } from '../secret-stores.mjs';

const OLD = 'old-value-that-is-long-enough-0123456789';

/**
 * A pretend stack. `stored` is what each store holds, and `events` the order things happened.
 * `failures` names the steps that fail, once each unless `sticky`.
 */
function world({ env = {}, failures = {}, sticky = false, confirmed = true, supplied } = {}) {
  const events = [];
  const state = {
    env: { ...env },
    stored: new Map(),
    journal: null,
    journalPhases: [],
    rotations: {},
    log: [],
  };
  const failing = (step) => {
    if (!failures[step]) return;
    const f = failures[step];
    if (!sticky) delete failures[step];
    throw new Error(typeof f === 'string' ? f : `${step} failed`);
  };
  const storeFor = (type) => ({
    async set(target, { auth, value }) {
      events.push(`set:${type}`);
      state.lastAuth = auth;
      failing(`set:${type}`);
      state.stored.set(type, value);
      failing(`set-applied:${type}`);
    },
    async verify(target, value) {
      if (type === 'gateway-key' || type === 'kc-demo-users') return null;
      if (failures[`reject:${type}`] === value) return false;
      return (state.stored.get(type) ?? OLD) === value;
    },
  });
  const deps = {
    stores: Object.fromEntries(
      [
        'pg',
        'mongo-root',
        'mongo-tenant',
        'kc-client',
        'kc-admin',
        'kc-demo-users',
        'gateway-key',
      ].map((t) => [t, storeFor(t)]),
    ),
    journal: {
      read: () => state.journal && structuredClone(state.journal),
      write(entry) {
        events.push(`journal:${entry.phase}`);
        state.journal = structuredClone(entry);
      },
      clear() {
        if (state.journal) events.push('journal:clear');
        state.journal = null;
      },
    },
    rotations: {
      record(id, date) {
        events.push('record');
        state.rotations[id] = date;
      },
    },
    now: () => new Date('2026-11-03T10:00:00Z'),
    log: (line) => state.log.push(line),
    readEnv: () => ({ ...state.env }),
    writeEnv(slug, updates) {
      events.push('env');
      failing('env');
      Object.assign(state.env, updates);
    },
    readValue: async () => supplied,
    async confirm(warning) {
      events.push('confirm');
      state.warning = warning;
      return confirmed;
    },
    async preflight() {
      events.push('preflight');
      failing('preflight');
    },
    async restart() {
      events.push('restart');
      failing('restart');
    },
    async check() {
      events.push('check');
      failing('check');
    },
  };
  return { deps, events, state };
}

const base = {
  POSTGRES_USER: 'katip',
  KC_DB_PASSWORD: OLD,
  LITELLM_DB_PASSWORD: OLD,
  LITELLM_DATABASE_URL: `postgresql://litellm:${OLD}@postgres:5432/litellm`,
  LITELLM_MASTER_KEY: OLD,
  MONGO_PASSWORD: OLD,
  KATIP_PII_TOKEN_KEY: OLD,
  ANTHROPIC_API_KEY: OLD,
  DEEPINFRA_API_KEY: '',
};
const tenantKey = (name) => `KATIP_T_ACME_CO_${name}`;

describe('the order of a rotation', () => {
  it('changes the store, tries it, writes the file, restarts, checks, and only then forgets', async () => {
    const w = world({ env: base });
    await rotate({ name: 'KC_DB_PASSWORD' }, { ...w.deps, confirm: async () => true });
    expect(w.events).toEqual([
      'preflight',
      'journal:prepared',
      'set:pg',
      'journal:stored',
      'env',
      'journal:written',
      'restart',
      'check',
      'record',
      'journal:clear',
    ]);
    expect(w.state.env.KC_DB_PASSWORD).not.toBe(OLD);
    expect(w.state.stored.get('pg')).toBe(w.state.env.KC_DB_PASSWORD);
    expect(w.state.journal).toBeNull();
    expect(w.state.rotations).toEqual({ KC_DB_PASSWORD: '2026-11-03' });
  });

  it('keeps the old and the new value on disk before it touches the store', async () => {
    const w = world({ env: base, failures: { 'set:pg': 'boom' } });
    let seen;
    const stores = {
      ...w.deps.stores,
      pg: {
        ...w.deps.stores.pg,
        async set(...a) {
          seen = structuredClone(w.state.journal);
          return w.deps.stores.pg.set(...a);
        },
      },
    };
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, { ...w.deps, stores })).rejects.toThrow();
    expect(seen.old.KC_DB_PASSWORD).toBe(OLD);
    expect(seen.new.KC_DB_PASSWORD).toMatch(/^[\w-]{32,}$/);
  });

  it('a secret with no store goes straight to the file and the restart', async () => {
    const w = world({ env: base });
    await rotate({ name: 'LITELLM_MASTER_KEY' }, w.deps);
    expect(w.events).toEqual([
      'preflight',
      'journal:prepared',
      'journal:stored',
      'env',
      'journal:written',
      'restart',
      'check',
      'record',
      'journal:clear',
    ]);
  });

  it('asks before one that disturbs people, and does nothing if refused', async () => {
    const w = world({ env: base, confirmed: false });
    await expect(rotate({ name: 'KATIP_PII_TOKEN_KEY' }, w.deps)).rejects.toThrow(/not confirmed/);
    expect(w.state.warning).toMatch(/Placeholders change/);
    expect(w.events).toEqual(['confirm']);
    expect(w.state.env.KATIP_PII_TOKEN_KEY).toBe(OLD);
  });

  it('checks the stack before it writes anything down', async () => {
    const w = world({ env: base, failures: { preflight: 'the stack is down' } });
    await expect(rotate({ name: 'LITELLM_MASTER_KEY' }, w.deps)).rejects.toThrow(/stack is down/);
    expect(w.state.journal).toBeNull();
    expect(w.state.env.LITELLM_MASTER_KEY).toBe(OLD);
  });

  it('refuses if the store does not hold what the file says', async () => {
    const w = world({ env: base });
    w.state.stored.set('pg', 'something-else-entirely');
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(/out of step/);
    expect(w.state.journal).toBeNull();
    expect(w.events).not.toContain('set:pg');
  });

  it('refuses while another rotation is unfinished', async () => {
    const w = world({ env: base, failures: { restart: 'no' } });
    await expect(rotate({ name: 'LITELLM_MASTER_KEY' }, w.deps)).rejects.toThrow(/not finished/);
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(
      /rotation of LITELLM_MASTER_KEY is not finished/,
    );
  });
});

describe('when it fails part-way', () => {
  it('a refused change leaves the old value, and nothing to finish', async () => {
    const w = world({ env: base, failures: { 'set:pg': 'role is missing' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(
      /nothing changed, and the old value is still in use[\s\S]*role is missing/,
    );
    expect(w.state.journal).toBeNull();
    expect(w.state.env.KC_DB_PASSWORD).toBe(OLD);
    expect(w.events).not.toContain('env');
    expect(w.state.rotations).toEqual({});
  });

  it('a change that errors after it took effect is put back', async () => {
    const w = world({ env: base, failures: { 'set-applied:pg': 'connection lost' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(/old value was put/);
    expect(w.state.stored.get('pg')).toBe(OLD);
    expect(w.state.journal).toBeNull();
    expect(w.state.env.KC_DB_PASSWORD).toBe(OLD);
  });

  it('if the file cannot be written, the store goes back too', async () => {
    const w = world({ env: base, failures: { env: 'disk full' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(
      /old value was put back[\s\S]*disk full/,
    );
    expect(w.state.stored.get('pg')).toBe(OLD);
    expect(w.state.journal).toBeNull();
  });

  it('puts Mongo back using the new password: the old one no longer logs in', async () => {
    const w = world({ env: base, failures: { env: 'disk full' } });
    await expect(
      rotate({ name: 'MONGO_PASSWORD' }, { ...w.deps, confirm: async () => true }),
    ).rejects.toThrow(/old value was put back/);
    const newValue = w.state.lastAuth;
    expect(newValue).not.toBe(OLD);
    expect(w.state.stored.get('mongo-root')).toBe(OLD);
  });

  it('if putting back fails too, it keeps both values and says how to finish', async () => {
    const w = world({ env: base, failures: { env: 'disk full' } });
    const original = w.deps.stores.pg.set;
    let calls = 0;
    w.deps.stores.pg.set = async (...a) => {
      calls++;
      if (calls === 2) throw new Error('postgres went away');
      return original(...a);
    };
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(
      /putting the old value back[\s\S]*postgres went away[\s\S]*--resume[\s\S]*--abort/,
    );
    expect(w.state.journal.old.KC_DB_PASSWORD).toBe(OLD);
  });

  it('a failed restart keeps both values and says exactly what to run', async () => {
    const w = world({ env: base, failures: { restart: 'keycloak unhealthy' } });
    const error = await rotate({ name: 'KC_DB_PASSWORD' }, w.deps).catch((e) => e);
    expect(error.message).toMatch(/keycloak unhealthy/);
    expect(error.message).toMatch(/pnpm secrets:rotate --resume/);
    expect(error.message).toMatch(/pnpm secrets:rotate --abort/);
    expect(w.state.journal.phase).toBe('written');
    expect(w.state.journal.old.KC_DB_PASSWORD).toBe(OLD);
    expect(w.state.rotations).toEqual({});
  });

  it('--resume restarts and finishes, without changing anything again', async () => {
    const w = world({ env: base, failures: { check: 'not healthy yet' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(/not finished/);
    const value = w.state.env.KC_DB_PASSWORD;
    w.events.length = 0;
    await resume(w.deps);
    expect(w.events).toEqual(['restart', 'check', 'record', 'journal:clear']);
    expect(w.state.env.KC_DB_PASSWORD).toBe(value);
    expect(w.state.journal).toBeNull();
  });

  it('--resume does not change a store twice after a crash mid-way', async () => {
    const w = world({ env: base });
    const newValue = 'new-value-that-is-long-enough-0123456789';
    w.state.stored.set('pg', newValue);
    w.state.journal = {
      name: 'KC_DB_PASSWORD',
      slug: null,
      phase: 'prepared',
      old: { KC_DB_PASSWORD: OLD },
      new: { KC_DB_PASSWORD: newValue },
    };
    await resume(w.deps);
    expect(w.events).not.toContain('set:pg');
    expect(w.state.env.KC_DB_PASSWORD).toBe(newValue);
  });

  it('--abort puts the old value back in the store and the file, and restarts', async () => {
    const w = world({ env: base, failures: { restart: 'no' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow(/not finished/);
    w.events.length = 0;
    await abort(w.deps);
    expect(w.events).toEqual(['set:pg', 'env', 'restart', 'check', 'journal:clear']);
    expect(w.state.stored.get('pg')).toBe(OLD);
    expect(w.state.env.KC_DB_PASSWORD).toBe(OLD);
    expect(w.state.rotations).toEqual({});
  });

  it('--abort after a crash just past the file write still restores the file', async () => {
    const w = world({ env: { ...base, KC_DB_PASSWORD: 'new-value' } });
    w.state.stored.set('pg', 'new-value');
    w.state.journal = {
      name: 'KC_DB_PASSWORD',
      slug: null,
      phase: 'stored',
      old: { KC_DB_PASSWORD: OLD },
      new: { KC_DB_PASSWORD: 'new-value' },
    };
    await abort(w.deps);
    expect(w.state.env.KC_DB_PASSWORD).toBe(OLD);
    expect(w.state.stored.get('pg')).toBe(OLD);
  });

  it('--abort keeps both values if it fails, and can be run again', async () => {
    const w = world({ env: base, failures: { restart: 'no' } });
    await expect(rotate({ name: 'KC_DB_PASSWORD' }, w.deps)).rejects.toThrow();
    const failing = world({ failures: { restart: 'still no' } });
    await expect(abort({ ...w.deps, restart: failing.deps.restart })).rejects.toThrow(
      /going back failed[\s\S]*--abort/,
    );
    expect(w.state.journal).not.toBeNull();
    await abort(w.deps);
    expect(w.state.journal).toBeNull();
  });

  it('--resume and --abort say so when there is nothing to do', async () => {
    const w = world({ env: base });
    await expect(resume(w.deps)).rejects.toThrow(/no rotation/);
    await expect(abort(w.deps)).rejects.toThrow(/no rotation/);
  });
});

describe('what each secret does', () => {
  it('changes LITELLM_DATABASE_URL with its password, in the same write', async () => {
    const w = world({ env: base });
    const writes = [];
    const writeEnv = (slug, updates) => {
      writes.push(Object.keys(updates));
      w.deps.writeEnv(slug, updates);
    };
    await rotate({ name: 'LITELLM_DB_PASSWORD' }, { ...w.deps, writeEnv });
    expect(writes).toEqual([['LITELLM_DB_PASSWORD', 'LITELLM_DATABASE_URL']]);
    expect(w.state.env.LITELLM_DATABASE_URL).toBe(
      `postgresql://litellm:${w.state.env.LITELLM_DB_PASSWORD}@postgres:5432/litellm`,
    );
  });

  it('leaves a LITELLM_DATABASE_URL someone wrote by hand', async () => {
    const custom = 'postgresql://someone:else@elsewhere:5432/litellm';
    const w = world({ env: { ...base, LITELLM_DATABASE_URL: custom } });
    await rotate({ name: 'LITELLM_DB_PASSWORD' }, w.deps);
    expect(w.state.env.LITELLM_DATABASE_URL).toBe(custom);
  });

  it('refuses LITELLM_DATABASE_URL itself, and says what to rotate', async () => {
    const w = world({ env: base });
    await expect(rotate({ name: 'LITELLM_DATABASE_URL' }, w.deps)).rejects.toThrow(
      /LITELLM_DB_PASSWORD/,
    );
  });

  it.each(['LC_CREDS_KEY', 'LC_CREDS_IV'])('refuses %s, and says why', async (name) => {
    const w = world({ env: { [tenantKey(name)]: OLD } });
    await expect(rotate({ name, slug: 'acme-co' }, w.deps)).rejects.toThrow(
      /makes data unreadable.*v0\.8\.7/s,
    );
    expect(w.events).toEqual([]);
  });

  it('takes a provider key from stdin, and never generates one', async () => {
    const supplied = 'sk-ant-a-new-key-from-the-provider';
    const w = world({ env: base, supplied });
    await rotate({ name: 'ANTHROPIC_API_KEY' }, w.deps);
    expect(w.state.env.ANTHROPIC_API_KEY).toBe(supplied);
    expect(w.state.log.join('\n')).toMatch(/revoke the old key at the provider/);
  });

  it('refuses an empty provider key: empty silently means the mock model', async () => {
    const w = world({ env: base, supplied: '' });
    await expect(rotate({ name: 'ANTHROPIC_API_KEY' }, w.deps)).rejects.toThrow(/never cleared/);
    expect(w.state.env.ANTHROPIC_API_KEY).toBe(OLD);
    expect(w.events).toEqual([]);
  });

  it('refuses a first provider key: that changes which model answers', async () => {
    const w = world({ env: base, supplied: 'sk-new-new-new-new' });
    await expect(rotate({ name: 'DEEPINFRA_API_KEY' }, w.deps)).rejects.toThrow(/first time/);
  });

  it('refuses a value that is the one it has now', async () => {
    const w = world({ env: base, supplied: OLD });
    await expect(rotate({ name: 'ANTHROPIC_API_KEY' }, w.deps)).rejects.toThrow(/value it has now/);
  });

  it('a company secret needs --tenant, and a platform one must not have it', async () => {
    const w = world({ env: base });
    await expect(rotate({ name: 'LC_JWT_SECRET' }, w.deps)).rejects.toThrow(/--tenant/);
    await expect(rotate({ name: 'VALKEY_PASSWORD', slug: 'acme-co' }, w.deps)).rejects.toThrow(
      /leave out --tenant/,
    );
    await expect(rotate({ name: 'NOPE' }, w.deps)).rejects.toThrow(/no such secret/);
    await expect(rotate({ name: 'LC_JWT_SECRET', slug: '../x' }, w.deps)).rejects.toThrow(
      /not a company slug/,
    );
  });

  it('MONGO_PASSWORD means the root user or the company login, by --tenant', async () => {
    const w = world({
      env: { ...base, [tenantKey('MONGO_PASSWORD')]: OLD },
    });
    await rotate({ name: 'MONGO_PASSWORD', slug: 'acme-co' }, w.deps);
    expect(w.events).toContain('set:mongo-tenant');
    expect(w.state.rotations).toEqual({ 'acme-co/MONGO_PASSWORD': '2026-11-03' });
    await rotate({ name: 'MONGO_PASSWORD' }, w.deps);
    expect(w.events).toContain('set:mongo-root');
  });

  it('a gateway key goes through its store, and no attempt at the key can be made there', async () => {
    const w = world({ env: { [tenantKey('GATEWAY_KEY')]: 'sk-sme-t-old' } });
    await rotate({ name: 'GATEWAY_KEY', slug: 'acme-co' }, w.deps);
    expect(w.events).toContain('set:gateway-key');
    expect(w.state.env[tenantKey('GATEWAY_KEY')]).toMatch(/^sk-sme-t-[\w-]+$/);
  });

  it('a gateway key that the provisioner refuses leaves nothing to finish', async () => {
    const w = world({
      env: { [tenantKey('GATEWAY_KEY')]: 'sk-sme-t-old' },
      failures: { 'set:gateway-key': 'unknown action' },
    });
    await expect(rotate({ name: 'GATEWAY_KEY', slug: 'acme-co' }, w.deps)).rejects.toThrow(
      /nothing changed/,
    );
    expect(w.state.journal).toBeNull();
  });

  it('warns before every company secret, as each one recreates its containers', async () => {
    for (const name of tenantSecretNames().filter((n) => !n.startsWith('LC_CREDS'))) {
      const w = world({ env: { [tenantKey(name)]: 'sk-sme-t-old-value' }, confirmed: false });
      await expect(rotate({ name, slug: 'acme-co' }, w.deps)).rejects.toThrow(/not confirmed/);
      expect(w.state.warning, name).toBeTruthy();
      expect(w.state.journal).toBeNull();
    }
    expect(platformSecretNames()).toContain('KATIP_PII_TOKEN_KEY');
  });
});

describe('generated values', () => {
  const names = [
    'POSTGRES_PASSWORD',
    'VALKEY_PASSWORD',
    'MONGO_PASSWORD',
    'KATIP_T_ACME_MONGO_PASSWORD',
    'KATIP_T_ACME_RAG_DB_PASSWORD',
  ];

  it('mean nothing in a URL, and pass the format db-seed.mjs asks for', () => {
    for (const name of names) {
      for (let i = 0; i < 300; i++) {
        const value = generateValue(name);
        expect(value).toMatch(/^[\w-]{32,}$/);
        expect(encodeURIComponent(value)).toBe(value);
        const url = new URL(`postgres://role:${value}@postgres:5432/db`);
        expect(url.password).toBe(value);
      }
    }
  });

  it('never start with a dash, which a start option would misread', () => {
    for (let i = 0; i < 3000; i++) expect(generateValue('VALKEY_PASSWORD')[0]).not.toBe('-');
  });

  it('keep the formats that LibreChat and the gateway need', () => {
    expect(generateValue('KATIP_T_ACME_GATEWAY_KEY')).toMatch(/^sk-sme-t-[\w-]+$/);
    expect(generateValue('KATIP_T_ACME_RAG_GATEWAY_KEY')).toMatch(/^sk-sme-t-[\w-]+$/);
  });

  it('a supplied value cannot hold what an env file would change', () => {
    expect(checkSuppliedValue('sk-ant-abc_DEF-123')).toBe('sk-ant-abc_DEF-123');
    for (const bad of ['', 'short', 'has space in it', 'has#hash-inside', 'has$dollar-inside']) {
      expect(() => checkSuppliedValue(bad)).toThrow();
    }
    expect(() => checkSuppliedValue('line-one\nline-two')).toThrow();
  });
});

describe('files', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'katip-rotation-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('changes one line of an env file, mode 600, and leaves nothing beside it', () => {
    const path = join(dir, 'a.env');
    writeFileSync(path, '# comment\nFIRST=one\nSECOND=two   # note\nTHIRD=three\n', {
      mode: 0o644,
    });
    updateEnvFile(path, { SECOND: 'changed' });
    expect(readFileSync(path, 'utf8')).toBe('# comment\nFIRST=one\nSECOND=changed\nTHIRD=three\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['a.env']);
  });

  it('refuses a key that is missing, or not on one line', () => {
    const path = join(dir, 'a.env');
    writeFileSync(path, 'A=1\nA=2\n');
    expect(() => updateEnvFile(path, { A: 'x' })).toThrow(/on 2/);
    expect(() => updateEnvFile(path, { B: 'x' })).toThrow(/on 0/);
    expect(readFileSync(path, 'utf8')).toBe('A=1\nA=2\n');
  });

  it('the journal is mode 600, and comes back as it went in', () => {
    const journal = fileJournal(join(dir, 'pending.env'));
    expect(journal.read()).toBeNull();
    journal.write({ name: 'X', old: { X: 'a' }, new: { X: 'b' } });
    expect(statSync(join(dir, 'pending.env')).mode & 0o777).toBe(0o600);
    expect(journal.read().new.X).toBe('b');
    journal.clear();
    expect(journal.read()).toBeNull();
  });

  it('the record holds names and dates, and no value', async () => {
    const path = join(dir, 'rotations.json');
    const w = world({ env: base });
    const deps = { ...w.deps, rotations: fileRotations(path) };
    await rotate({ name: 'LITELLM_MASTER_KEY' }, deps);
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text)).toEqual({ LITELLM_MASTER_KEY: '2026-11-03' });
    expect(text).not.toContain(w.state.env.LITELLM_MASTER_KEY);
    expect(text).not.toContain(OLD);
  });
});

describe('--list', () => {
  const rows = (rotations = {}, now = new Date('2026-11-03')) =>
    listSecrets({
      platformEnv: { ...base, MOCK_LLM_KEY: OLD },
      slugs: ['acme-co'],
      tenantEnv: () => ({ [tenantKey('LC_CREDS_KEY')]: OLD, [tenantKey('LC_JWT_SECRET')]: OLD }),
      rotations,
      now,
    });
  const of = (list, id) => list.find((r) => r.id === id);

  it('shows whether each can rotate, for the platform and each company', () => {
    const list = rows();
    expect(of(list, 'KC_DB_PASSWORD').rotate).toBe('yes');
    expect(of(list, 'ANTHROPIC_API_KEY').rotate).toMatch(/provider/);
    expect(of(list, 'acme-co/LC_CREDS_KEY').rotate).toBe('refuses');
    expect(of(list, 'acme-co/LC_JWT_SECRET').rotate).toBe('yes');
  });

  it('marks what is past 90 days, or was never rotated', () => {
    const list = rows({
      KC_DB_PASSWORD: '2026-10-01',
      MONGO_PASSWORD: '2026-07-01',
    });
    expect(of(list, 'KC_DB_PASSWORD')).toMatchObject({
      lastRotated: '2026-10-01',
      overdue: false,
    });
    expect(of(list, 'MONGO_PASSWORD').overdue).toBe(true);
    expect(of(list, 'LITELLM_MASTER_KEY')).toMatchObject({ lastRotated: null, overdue: true });
  });

  it('a secret that is not set, or refuses, is never due', () => {
    const list = rows();
    expect(of(list, 'DEEPINFRA_API_KEY')).toMatchObject({ isSet: false, overdue: false });
    expect(of(list, 'acme-co/LC_CREDS_KEY').overdue).toBe(false);
  });

  it('holds no value', () => {
    expect(JSON.stringify(rows())).not.toContain(OLD);
  });
});

describe('nothing shows a secret', () => {
  it('no log line or error from a failed rotation holds either value', async () => {
    const w = world({ env: base, failures: { restart: 'compose failed' } });
    const error = await rotate({ name: 'KC_DB_PASSWORD' }, w.deps).catch((e) => e);
    const newValue = w.state.env.KC_DB_PASSWORD;
    const shown = `${error.message}\n${w.state.log.join('\n')}`;
    expect(shown).not.toContain(OLD);
    expect(shown).not.toContain(newValue);
  });

  it('scrub hides a value, raw or as it would be in a URL', () => {
    const value = 'p\'a"s$w o%rd';
    expect(scrub(`x ${value} y ${encodeURIComponent(value)} z`, [value])).toBe('x *** y *** z');
    expect(scrub('nothing here', [undefined, '', 'abc'])).toBe('nothing here');
  });

  it('a store that cannot try a value says so, rather than saying yes', async () => {
    const calls = [];
    const keycloak = async (action, env) => {
      calls.push({ action, env });
      return 'result=valid';
    };
    const stores = realStores({
      containers: { postgres: () => 'p', mongo: () => 'm', ragdb: () => 'r' },
      platformEnv: () => ({ POSTGRES_USER: 'katip', MONGO_USER: 'katip', MONGO_PASSWORD: 'root' }),
      keycloak,
      setGatewayKey: async () => {},
    });
    const target = { recipe: { store: { clientId: 'lc-a' } }, slug: 'a' };
    expect(await stores['kc-client'].verify(target, 'value')).toBe(true);
    expect(calls[0].env.KC_VALUE).toBe('value');
    expect(await stores['gateway-key'].verify(target, 'value')).toBeNull();
    expect(await stores['kc-demo-users'].verify(target, 'value')).toBeNull();
  });
});
