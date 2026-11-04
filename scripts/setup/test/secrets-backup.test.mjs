// SPDX-License-Identifier: AGPL-3.0-only
// Made-up files only.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backup, MIN_PASSPHRASE, PENDING_FILE, restore } from '../secrets-backup.mjs';

const PASSPHRASE = 'a-made-up-passphrase-for-a-test';
const MAIN = 'POSTGRES_PASSWORD=made-up-platform-value\nFOO=türkçe değer\n';
const TENANT = 'KATIP_T_ACME_MONGO_PASSWORD=made-up-tenant-value\n';

let dir;
let envDir;
let repoRoot;
let to;

const makeSecrets = (where = envDir) => {
  mkdirSync(join(where, 'tenants'), { recursive: true });
  writeFileSync(join(where, 'katip.env'), MAIN, { mode: 0o600 });
  writeFileSync(join(where, 'tenants', 'acme.secrets.env'), TENANT, { mode: 0o600 });
  writeFileSync(join(where, 'tenants', 'acme.env'), 'CREDS_KEY=made-up\n', { mode: 0o600 });
};

const take = (extra = {}) => backup({ envDir, repoRoot, to, passphrase: PASSPHRASE, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'katip-backup-'));
  envDir = join(dir, 'repo', 'infra', 'env');
  repoRoot = join(dir, 'repo');
  to = join(dir, 'elsewhere', 'secrets.enc');
  makeSecrets();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('secrets:backup', () => {
  it('writes one encrypted file, mode 600, that holds no plaintext', async () => {
    const { fileCount } = await take();
    expect(fileCount).toBe(3);
    expect(statSync(to).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(to);
    expect(bytes.subarray(0, 8).toString()).toBe('Salted__');
    for (const secret of ['made-up-platform-value', 'made-up-tenant-value', 'POSTGRES_PASSWORD']) {
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.includes(Buffer.from(secret).toString('base64'))).toBe(false);
    }
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual(['secrets.enc']);
  });

  it('can be opened with plain openssl, with the settings in the file header', async () => {
    await take();
    const out = execFileSync(
      'openssl',
      [
        'enc',
        '-d',
        '-aes-256-cbc',
        '-pbkdf2',
        '-iter',
        '600000',
        '-md',
        'sha256',
        '-in',
        to,
        '-pass',
        'env:TEST_PASS',
      ],
      { env: { PATH: process.env.PATH, TEST_PASS: PASSPHRASE } },
    );
    const { files } = JSON.parse(out.toString());
    expect(Buffer.from(files[0].base64, 'base64').toString()).toBe(MAIN);
  });

  it(`refuses a passphrase under ${MIN_PASSPHRASE} characters, and writes nothing`, async () => {
    await expect(take({ passphrase: 'x'.repeat(MIN_PASSPHRASE - 1) })).rejects.toThrow(/at least/);
    await expect(take({ passphrase: '' })).rejects.toThrow(/at least/);
    await expect(take({ passphrase: undefined })).rejects.toThrow(/at least/);
    expect(existsSync(to)).toBe(false);
  });

  it('never overwrites a backup without being told to', async () => {
    await take();
    const first = readFileSync(to);
    await expect(take()).rejects.toThrow(/exists.*--force/);
    expect(readFileSync(to).equals(first)).toBe(true);
    await take({ force: true });
    expect(readFileSync(to).equals(first)).toBe(false);
  });

  it('refuses a path inside the repository', async () => {
    await expect(take({ to: join(repoRoot, 'secrets.enc') })).rejects.toThrow(/inside this repo/);
    await expect(take({ to: join(envDir, 'secrets.enc') })).rejects.toThrow(/inside this repo/);
  });

  it('refuses while a rotation is unfinished', async () => {
    writeFileSync(join(envDir, PENDING_FILE), '{}');
    await expect(take()).rejects.toThrow(/rotation is not finished/);
  });

  it('refuses if there is nothing to back up', async () => {
    rmSync(join(envDir, 'katip.env'));
    await expect(take()).rejects.toThrow(/does not exist/);
  });

  it('does not follow a link out of tenants/', async () => {
    const outside = join(dir, 'outside.env');
    writeFileSync(outside, 'NOT_OURS=1\n');
    symlinkSync(outside, join(envDir, 'tenants', 'sneaky.env'));
    const { fileCount } = await take();
    expect(fileCount).toBe(3);
  });

  it('leaves no file behind when the check fails', async () => {
    // A read-only directory stops the write, the first thing past the encryption.
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    chmodSync(join(dir, 'elsewhere'), 0o500);
    await expect(take()).rejects.toThrow();
    chmodSync(join(dir, 'elsewhere'), 0o700);
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });
});

describe('secrets:restore', () => {
  const target = () => join(dir, 'new-machine', 'infra', 'env');
  const put = (extra = {}) =>
    restore({ envDir: target(), from: to, passphrase: PASSPHRASE, ...extra });

  it('a round trip brings back every file, the same, mode 600', async () => {
    await take();
    const { paths } = await put();
    expect(paths.sort()).toEqual(['katip.env', 'tenants/acme.env', 'tenants/acme.secrets.env']);
    expect(readFileSync(join(target(), 'katip.env'), 'utf8')).toBe(MAIN);
    expect(readFileSync(join(target(), 'tenants', 'acme.secrets.env'), 'utf8')).toBe(TENANT);
    for (const p of paths) expect(statSync(join(target(), p)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(target(), 'tenants')).sort()).toEqual(['acme.env', 'acme.secrets.env']);
  });

  it('refuses the wrong passphrase, writes nothing, and shows neither', async () => {
    await take();
    const wrong = 'not-the-right-passphrase-at-all';
    const error = await put({ passphrase: wrong }).catch((e) => e);
    expect(error.message).toMatch(/passphrase is wrong, or the file is damaged/);
    expect(error.message).not.toContain(wrong);
    expect(error.message).not.toContain(PASSPHRASE);
    expect(existsSync(target())).toBe(false);
  });

  it('refuses a damaged file', async () => {
    await take();
    const bytes = readFileSync(to);
    bytes[bytes.length - 40] ^= 0xff;
    writeFileSync(to, bytes);
    await expect(put()).rejects.toThrow(/damaged/);
    expect(existsSync(target())).toBe(false);
  });

  it('refuses to overwrite, restores none of it, and names what is in the way', async () => {
    await take();
    mkdirSync(join(target(), 'tenants'), { recursive: true });
    writeFileSync(join(target(), 'tenants', 'acme.env'), 'KEEP=me\n');
    await expect(put()).rejects.toThrow(/tenants\/acme\.env[\s\S]*|--force/);
    expect(readFileSync(join(target(), 'tenants', 'acme.env'), 'utf8')).toBe('KEEP=me\n');
    expect(existsSync(join(target(), 'katip.env'))).toBe(false);
  });

  it('overwrites when told to, and leaves files the backup does not hold', async () => {
    await take();
    mkdirSync(join(target(), 'tenants'), { recursive: true });
    writeFileSync(join(target(), 'katip.env'), 'OLD=yes\n');
    writeFileSync(join(target(), 'tenants', 'other.env'), 'OTHER=yes\n');
    const { overwritten } = await put({ force: true });
    expect(overwritten).toEqual(['katip.env']);
    expect(readFileSync(join(target(), 'katip.env'), 'utf8')).toBe(MAIN);
    expect(readFileSync(join(target(), 'tenants', 'other.env'), 'utf8')).toBe('OTHER=yes\n');
  });

  it('refuses a backup that names a path outside infra/env', async () => {
    const plain = JSON.stringify({
      format: 'katip-secrets-backup',
      version: 1,
      files: [{ path: '../../evil', sha256: 'x', base64: '' }],
    });
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    execFileSync(
      'openssl',
      [
        'enc',
        '-aes-256-cbc',
        '-pbkdf2',
        '-iter',
        '600000',
        '-md',
        'sha256',
        '-salt',
        '-out',
        to,
        '-pass',
        'env:TEST_PASS',
      ],
      { input: plain, env: { PATH: process.env.PATH, TEST_PASS: PASSPHRASE } },
    );
    await expect(put()).rejects.toThrow(/outside infra\/env/);
    expect(existsSync(join(dir, 'new-machine', 'evil'))).toBe(false);
  });

  it('says so when the file is not there, or no path was given', async () => {
    await expect(put()).rejects.toThrow(/does not exist/);
    await expect(put({ from: undefined })).rejects.toThrow(/--from/);
  });
});
