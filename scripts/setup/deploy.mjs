#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm dev:deploy                      # back up, keep the running images, rebuild, migrate, check
 * pnpm dev:deploy-back [--yes]             # the images from before the last deploy
 * pnpm dev:deploy-back --restore-data      # and its database copy. Always asks
 *
 * `pnpm deploy` without `run` is pnpm's own command, which never reaches this file.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { runBack, runDeploy } from './deploy-lib.mjs';
import {
  AUTO_KEYS,
  PLATFORM_SERVICES,
  allTenants,
  deriveEnv,
  loadAllTenantSecrets,
  platformCompose,
  tenantCompose,
} from './steps.mjs';
import { adoptTenantSecretsFromEnvFile } from './tenants.mjs';
import { askLine, dim, err } from './tui.mjs';
import { INFRA, ROOT, STATE_DIR, ensureEnvFile, run, runFromFile, runToFile } from './util.mjs';

/** dev:up itself, with its own progress display and its keep-or-rollback prompt. */
function runUp(flags) {
  return new Promise((resolve, reject) => {
    // Ctrl+C reaches dev:up too, and it's the one to decide what happens next.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const child = spawn(
      process.execPath,
      [join(ROOT, 'scripts', 'setup', 'main.mjs'), 'up', ...flags],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      process.off('SIGINT', ignore);
      resolve(code ?? 1);
    });
  });
}

/** Everything that writes to the two databases. Keycloak writes only to its own. */
async function stopWriters(config) {
  adoptTenantSecretsFromEnvFile(INFRA);
  const env = ensureEnvFile(AUTO_KEYS, deriveEnv).env;
  const ctx = { config, infra: INFRA, env, log: () => {} };
  loadAllTenantSecrets(ctx);
  for (const t of allTenants(ctx)) await tenantCompose(['stop'], ctx, t);
  const { out } = await platformCompose(['config', '--services'], ctx);
  const writers = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !PLATFORM_SERVICES.includes(s));
  await platformCompose(['stop', ...writers], ctx);
}

const main = async () => {
  const command = process.argv[2];
  const rest = process.argv.slice(3).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: rest,
    options: {
      yes: { type: 'boolean', default: false },
      'restore-data': { type: 'boolean', default: false },
    },
  });
  const config = loadConfig();
  const sys = {
    git: (args) => run('git', args),
    docker: (args) => run('docker', args),
    dockerToFile: (args, file) => runToFile('docker', args, file),
    dockerFromFile: (args, file) => runFromFile('docker', args, file),
    runUp,
    stopWriters: () => stopWriters(config),
    ask: askLine,
    now: () => new Date(),
    print: (line) => console.log(line),
    printError: (line) => console.error(err(line)),
  };
  const where = { config, stateDir: STATE_DIR, root: ROOT };
  if (command === 'deploy') return runDeploy(sys, where);
  if (command === 'back') {
    return runBack(sys, {
      ...where,
      restoreData: values['restore-data'],
      yes: values.yes,
      interactive: Boolean(process.stdin.isTTY),
    });
  }
  console.error(dim('usage: pnpm dev:deploy | pnpm dev:deploy-back [--yes] [--restore-data]'));
  return 2;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(err(`fatal: ${e.message}`));
    process.exitCode = 1;
  },
);
