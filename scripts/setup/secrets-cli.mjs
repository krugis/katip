#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm secrets:rotate <NAME> [--tenant <slug>] [--yes]  # one secret, safely
 * pnpm secrets:rotate --list [--tenant <slug>]          # each secret, and when it last rotated
 * pnpm secrets:rotate --resume | --abort                # finish, or undo, one that stopped
 * pnpm secrets:backup --to <path> [--force]             # one encrypted file of infra/env's secrets
 * pnpm secrets:restore --from <path> [--force]          # puts them back
 *
 * A provider's new key comes from stdin, or a prompt. A passphrase comes from a prompt or
 * KATIP_BACKUP_PASSPHRASE. Neither is ever an argument. See docs/runbooks/secret-rotation.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import {
  abort,
  fileJournal,
  fileRotations,
  listSecrets,
  resume,
  rotate,
  updateEnvFile,
} from './secret-rotation.mjs';
import { realStores, scrub } from './secret-stores.mjs';
import {
  backup,
  checkNewPassphrase,
  MIN_PASSPHRASE,
  PASSPHRASE_ENV,
  PENDING_FILE,
  restore,
} from './secrets-backup.mjs';
import {
  platformCompose,
  runOnEdge,
  runProvisionerWith,
  smokeTenant,
  startTenant,
  tenantProject,
  tenantStatuses,
} from './steps.mjs';
import { knownTenantSlugs, tenantSecretsFile } from './tenants.mjs';
import { INFRA, ROOT, STATE_DIR, parseEnvFile, run, tryRun } from './util.mjs';

const ENV_DIR = join(INFRA, 'env');
const PLATFORM_ENV = join(ENV_DIR, 'katip.env');
const ROTATIONS_FILE = join(STATE_DIR, 'rotations.json');

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');

const OPTIONS = {
  rotate: {
    tenant: { type: 'string' },
    list: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    abort: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
  backup: { to: { type: 'string' }, force: { type: 'boolean', default: false } },
  restore: { from: { type: 'string' }, force: { type: 'boolean', default: false } },
};

/** Reads a line from the terminal without showing it. */
async function askHidden(prompt) {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(prompt);
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const readEnvFile = (path) => (existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {});
const tenantEnv = (slug) => readEnvFile(tenantSecretsFile(INFRA, slug));

/** Everything compose and the setup steps read: katip.env, and every company's file. */
function loadEverything(ctx) {
  ctx.env = { ...readEnvFile(PLATFORM_ENV) };
  for (const slug of knownTenantSlugs(INFRA)) Object.assign(ctx.env, tenantEnv(slug));
}

function realDeps(values, knownSecrets) {
  const config = loadConfig();
  const project = config.project.name;
  const ctx = { config, infra: INFRA, env: {}, log: () => {} };
  loadEverything(ctx);
  knownSecrets.push(ctx);

  const container = (service) => `${project}-${service}-1`;
  const running = async (name) =>
    (await run('docker', ['inspect', '-f', '{{.State.Running}}', name])).out.trim() === 'true';

  const stores = realStores({
    containers: {
      postgres: () => container('postgres'),
      mongo: () => container('mongodb'),
      ragdb: (slug) => `${tenantProject(config, { slug })}-ragdb-${slug}-1`,
    },
    platformEnv: () => readEnvFile(PLATFORM_ENV),
    keycloak: async (action, env) => {
      const { out } = await runOnEdge(
        ctx,
        { slug: 'none' },
        'secret-kc.mjs',
        { KC_ACTION: action, KC_REALM: config.identity.realm, ...env },
        undefined,
        {},
      );
      return out;
    },
    setGatewayKey: (slug, value) =>
      runProvisionerWith(ctx, 'gateway-key', { slug }, { TENANT_GATEWAY_KEY: value }),
  });

  return {
    stores,
    journal: fileJournal(join(ENV_DIR, PENDING_FILE)),
    rotations: fileRotations(ROTATIONS_FILE, (path, content) => {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(path, content);
    }),
    now: () => new Date(),
    log: (line) => console.log(line),
    readEnv: (slug) => {
      if (slug && !existsSync(tenantSecretsFile(INFRA, slug))) {
        throw new Error(`there is no company ${slug} on this host`);
      }
      if (!existsSync(PLATFORM_ENV)) throw new Error('no infra/env/katip.env: run pnpm dev:up');
      return slug ? tenantEnv(slug) : readEnvFile(PLATFORM_ENV);
    },
    writeEnv(slug, updates) {
      updateEnvFile(slug ? tenantSecretsFile(INFRA, slug) : PLATFORM_ENV, updates);
      loadEverything(ctx);
    },
    async readValue(id) {
      if (process.stdin.isTTY) return (await askHidden(`New value for ${id}: `)).trim();
      return readStdin();
    },
    async confirm(warning) {
      console.log(`Warning: ${warning}`);
      if (values.yes) return true;
      if (!process.stdin.isTTY) {
        throw new Error('this needs a person to agree: add --yes. Nothing changed.');
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Go on? [y/N] ');
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    },
    async preflight({ recipe, slug }) {
      // Refused here rather than started: compose would bring up what wasn't running.
      if (slug) {
        const status = (await tenantStatuses(ctx))[slug];
        if (status !== 'active') {
          throw new Error(`company ${slug} is ${status ?? 'unknown'}: only an active one rotates`);
        }
        await smokeTenant(ctx, { slug });
        return;
      }
      const needed = [...recipe.restart];
      if (recipe.store?.type === 'pg') needed.push('postgres');
      if (recipe.store?.type === 'mongo-root') needed.push('mongodb');
      if (recipe.store?.type?.startsWith('kc-')) needed.push('keycloak');
      for (const service of new Set(needed)) {
        if (!(await running(container(service)))) {
          throw new Error(`${service} is not running. Nothing changed. Start the stack first.`);
        }
      }
      if (!existsSync(join(ROOT, 'infra', 'compose', 'rendered', 'tenants.yml'))) {
        throw new Error('the rendered compose file is missing: run pnpm dev:up. Nothing changed.');
      }
    },
    async restart({ recipe, slug }) {
      if (slug) {
        console.log(`Recreating ${slug}'s containers`);
        await startTenant(ctx, { slug }, { recreate: true });
        return;
      }
      if (recipe.restart.length === 0) return;
      console.log(`Recreating ${recipe.restart.join(', ')}`);
      await platformCompose(
        ['up', '-d', '--wait', '--wait-timeout', '300', '--force-recreate', '--no-deps'].concat(
          recipe.restart,
        ),
        ctx,
      );
    },
    async check({ slug }) {
      if (!slug) return; // compose --wait has waited for each service's health check
      await smokeTenant(ctx, { slug });
      // Its own LibreChat, with the key in its own environment, against its own search.
      const lc = `${tenantProject(config, { slug })}-lc-${slug}-1`;
      await tryRun('docker', [
        'exec',
        lc,
        'node',
        '-e',
        'fetch(process.env.MEILI_HOST+"/indexes",{headers:{Authorization:"Bearer "+process.env.MEILI_MASTER_KEY}}).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
      ]);
    },
  };
}

function printList(values) {
  if (values.tenant && !/^[a-z0-9-]{3,32}$/.test(values.tenant)) {
    throw new Error(`not a company slug: ${values.tenant}`);
  }
  const slugs = values.tenant ? [values.tenant] : knownTenantSlugs(INFRA);
  const rows = listSecrets({
    platformEnv: readEnvFile(PLATFORM_ENV),
    slugs,
    tenantEnv,
    rotations: fileRotations(ROTATIONS_FILE).read(),
  });
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const state = !r.isSet ? 'not set' : r.overdue ? 'due' : '';
    console.log(
      `${r.id.padEnd(width)}  ${r.rotate.padEnd(27)}  ${(r.lastRotated ?? 'never').padEnd(10)}  ${state}`.trimEnd(),
    );
  }
  const pending = fileJournal(join(ENV_DIR, PENDING_FILE)).read();
  if (pending) {
    console.log(`\nNot finished: ${pending.name}. pnpm secrets:rotate --resume, or --abort.`);
  }
}

async function runRotate(values, positionals, known) {
  if (values.list) {
    printList(values);
    return;
  }
  const deps = realDeps(values, known);
  if (values.resume) return resume(deps);
  if (values.abort) return abort(deps);
  const [name] = positionals;
  if (!name) throw new Error('name a secret, or use --list');
  return rotate({ name, slug: values.tenant ?? null }, deps);
}

/** The passphrase, from the environment or a prompt. Never an argument. */
async function passphraseFor({ confirm }) {
  const fromEnv = process.env[PASSPHRASE_ENV];
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(`set ${PASSPHRASE_ENV}, or run this at a terminal to be asked`);
  }
  const first = await askHidden(
    confirm ? `Passphrase (${MIN_PASSPHRASE} characters or more): ` : 'Passphrase: ',
  );
  if (confirm) {
    checkNewPassphrase(first);
    if ((await askHidden('Again: ')) !== first) throw new Error('the two did not match');
  }
  return first;
}

async function runBackup(values) {
  const passphrase = await passphraseFor({ confirm: true });
  const { fileCount, bytes } = await backup({
    envDir: ENV_DIR,
    repoRoot: ROOT,
    to: values.to,
    passphrase,
    force: values.force,
  });
  console.log(`Wrote ${values.to}: ${fileCount} files, ${bytes} bytes. Decrypted and compared.`);
  console.log('If the passphrase is lost, this backup is lost: nothing can open it.');
  console.log('Move this file off this machine. A copy here dies with what it protects.');
  console.log('It holds these values as they are today: take a new one after any rotation.');
}

async function runRestore(values) {
  const passphrase = await passphraseFor({ confirm: false });
  const { paths, overwritten } = await restore({
    envDir: ENV_DIR,
    from: values.from,
    passphrase,
    force: values.force,
  });
  console.log(`Restored ${paths.length} files to infra/env, mode 600.`);
  if (overwritten.length > 0) console.log(`Overwrote: ${overwritten.join(', ')}.`);
  console.log('They only work with the volumes from the same time. See docs/runbooks/restore.md.');
}

const COMMANDS = { rotate: runRotate, backup: runBackup, restore: runRestore };

// Whatever went wrong, no value we know of reaches the screen.
const known = [];
try {
  const fn = COMMANDS[command];
  if (!fn) throw new Error('usage: secrets-cli.mjs rotate|backup|restore');
  const { values, positionals } = parseArgs({
    args: rest,
    options: OPTIONS[command],
    allowPositionals: command === 'rotate',
  });
  await fn(values, positionals, known);
} catch (e) {
  const pending = fileJournal(join(ENV_DIR, PENDING_FILE));
  let journal = null;
  try {
    journal = pending.read();
  } catch {
    /* the message below is still useful */
  }
  const secrets = [
    process.env[PASSPHRASE_ENV],
    // Not the short ones: katip.env also holds names, which are in every container's name.
    ...known.flatMap((ctx) => Object.values(ctx.env)).filter((v) => v.length >= 16),
    ...Object.values(journal?.old ?? {}),
    ...Object.values(journal?.new ?? {}),
  ];
  console.error(scrub(e.message, secrets));
  process.exitCode = 1;
}
