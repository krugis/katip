// SPDX-License-Identifier: AGPL-3.0-only
// One encrypted file holding infra/env/katip.env and infra/env/tenants/*. The plaintext only
// ever exists in this process's memory and in pipes to openssl, so there is no temp file to
// leave behind. Standard, so it can be opened without this tool:
//   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <file> -pass env:<VAR>
// which gives JSON with each file in base64.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { writeFileAtomic600 } from './secret-rotation.mjs';

export const PASSPHRASE_ENV = 'KATIP_BACKUP_PASSPHRASE';
export const MIN_PASSPHRASE = 16;
export const PENDING_FILE = 'rotation-pending.env';

const FORMAT = 'katip-secrets-backup';
const CIPHER = ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-md', 'sha256', '-salt'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Pipes `input` through openssl. The passphrase reaches it through its environment only. */
function openssl(args, input, passphrase) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn('openssl', [...args, '-pass', `env:${PASSPHRASE_ENV}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, [PASSPHRASE_ENV]: passphrase },
    });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.resume();
    p.on('error', (e) => rejectP(new Error(`could not run openssl: ${e.code ?? e.message}`)));
    p.on('close', (code) => resolveP({ code, out: Buffer.concat(out) }));
    // openssl may stop reading early on a bad file. Its exit code says so.
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

async function encrypt(plain, passphrase) {
  const { code, out } = await openssl(CIPHER, plain, passphrase);
  if (code !== 0) throw new Error(`openssl could not encrypt (exit ${code})`);
  return out;
}

const decrypt = (cipher, passphrase) => openssl([...CIPHER, '-d'], cipher, passphrase);

/** katip.env and every regular file in tenants/. A link could point at anything, so isn't read. */
function collect(envDir) {
  const main = join(envDir, 'katip.env');
  if (!existsSync(main)) throw new Error('infra/env/katip.env does not exist: nothing to back up');
  const tenants = join(envDir, 'tenants');
  const names = existsSync(tenants) ? readdirSync(tenants).sort() : [];
  const paths = [
    'katip.env',
    ...names.filter((n) => lstatSync(join(tenants, n)).isFile()).map((n) => `tenants/${n}`),
  ];
  return paths.map((path) => {
    const data = readFileSync(join(envDir, path));
    return { path, sha256: sha256(data), base64: data.toString('base64') };
  });
}

const isInside = (dir, path) => {
  const r = relative(resolve(dir), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..');
};

export function checkNewPassphrase(passphrase) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
}

/** Writes the backup, and only reports success once it has decrypted it and compared. */
export async function backup({
  envDir,
  repoRoot,
  to,
  passphrase,
  force = false,
  now = new Date(),
}) {
  if (!to) throw new Error('add --to <path>');
  checkNewPassphrase(passphrase);
  if (isInside(repoRoot, to)) {
    throw new Error(
      'the backup must not be inside this repository, where it could be committed, and would be lost with it',
    );
  }
  if (existsSync(join(envDir, PENDING_FILE))) {
    throw new Error(
      'a secret rotation is not finished. Finish it first (pnpm secrets:rotate --resume or --abort), or the backup could hold a value that does not work',
    );
  }
  if (existsSync(to) && !force) throw new Error(`${to} exists. Add --force to replace it`);

  const files = collect(envDir);
  const plain = Buffer.from(
    JSON.stringify({ format: FORMAT, version: 1, createdAt: now.toISOString(), files }),
  );
  const cipher = await encrypt(plain, passphrase);

  mkdirSync(dirname(resolve(to)), { recursive: true });
  // It's encrypted, so this may sit next to its destination until it's proved good.
  const tmp = `${to}.unverified-${process.pid}`;
  try {
    writeFileSync(tmp, cipher, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    const check = await decrypt(readFileSync(tmp), passphrase);
    if (check.code !== 0 || !check.out.equals(plain)) {
      throw new Error('the file written did not decrypt to the same content, so it was not kept');
    }
    renameSync(tmp, to);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { fileCount: files.length, bytes: cipher.length };
}

const SAFE_PATH = /^(katip\.env|tenants\/[A-Za-z0-9_][A-Za-z0-9._-]*)$/;

const unreadable = (from) =>
  new Error(`could not open ${from}: the passphrase is wrong, or the file is damaged`);

/** Reads and proves a backup: nothing is written unless all of it is good. */
async function open(from, passphrase) {
  if (!from) throw new Error('add --from <path>');
  if (!existsSync(from)) throw new Error(`${from} does not exist`);
  const { code, out } = await decrypt(readFileSync(from), passphrase);
  if (code !== 0) throw unreadable(from);
  let parsed;
  try {
    parsed = JSON.parse(out.toString('utf8'));
  } catch {
    // CBC has no integrity of its own: a wrong passphrase can get past the padding check.
    throw unreadable(from);
  }
  if (parsed?.format !== FORMAT || parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw unreadable(from);
  }
  return parsed.files.map(({ path, sha256: expected, base64 }) => {
    if (typeof path !== 'string' || !SAFE_PATH.test(path)) {
      throw new Error(`${from} names a file outside infra/env, so nothing was restored`);
    }
    const data = Buffer.from(base64, 'base64');
    if (sha256(data) !== expected) throw unreadable(from);
    return { path, data };
  });
}

/** Puts the files back, mode 600. Refuses all of them if any exists, unless `force`. */
export async function restore({ envDir, from, passphrase, force = false }) {
  if (!passphrase) throw new Error('a passphrase is needed');
  const files = await open(from, passphrase);
  const existing = files.filter((f) => existsSync(join(envDir, f.path))).map((f) => f.path);
  if (existing.length > 0 && !force) {
    throw new Error(
      `these exist, so nothing was restored. Add --force to overwrite them: ${existing.join(', ')}`,
    );
  }
  mkdirSync(join(envDir, 'tenants'), { recursive: true, mode: 0o700 });
  for (const { path, data } of files) {
    writeFileAtomic600(join(envDir, path), data);
    if (!readFileSync(join(envDir, path)).equals(data)) {
      throw new Error(`${path} did not read back the same`);
    }
  }
  return { paths: files.map((f) => f.path), overwritten: existing };
}
