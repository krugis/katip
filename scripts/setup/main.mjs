#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kâtip one-stop bootstrap (tracker P0-12…P0-16). See scripts/setup/ modules.
 *
 *   pnpm dev:up        run or resume the bootstrap (default)
 *   pnpm dev:status    show step state + service health
 *   pnpm dev:down      stop all services (data and state kept)
 *   pnpm dev:rollback  remove everything the bootstrap created (asks)
 *
 * Flags: --fresh (ignore state), --redo <ids> (force steps), --yes (no prompts)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  ROOT,
  STATE_DIR,
  ensureEnvFile,
  loadState,
  saveState,
  parseYaml,
  tryRun,
  requestInterrupt,
} from './util.mjs';
import { AUTO_KEYS, TENANT_PROJECT, composeEnv, deriveEnv, steps } from './steps.mjs';
import { Tui, bold, dim, err, ok, warn } from './tui.mjs';

const argv = process.argv.slice(2);
const command = ['up', 'status', 'down', 'rollback'].includes(argv[0]) ? argv[0] : 'up';
const fresh = argv.includes('--fresh');
const redoRaw = argv.find((a) => a.startsWith('--redo='));
const redo = redoRaw
  ? redoRaw
      .slice(7)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const yes = argv.includes('--yes');

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------
function makeCtx() {
  const config = parseYaml(readFileSync(join(ROOT, 'katip.config.yaml'), 'utf8'));
  let currentLog = null;
  const ctx = {
    config,
    infra: join(ROOT, 'infra'),
    env: null,
    tui: null,
    log(msg) {
      const line = `[${new Date().toISOString()}] ${msg}`;
      if (currentLog) currentLog.push(line);
    },
    ensureEnv: () => {
      const r = ensureEnvFile(AUTO_KEYS, deriveEnv);
      if (!ctx.env) ctx.env = r.env;
      currentLog = null;
      return r;
    },
    bindLog(file) {
      currentLog = file;
    },
  };
  return ctx;
}

// flow control ---------------------------------------------------------------
let interrupted = false;

function armInterrupt() {
  process.on('SIGINT', () => {
    if (interrupted) {
      // second Ctrl+C: force exit (user insists)
      process.exit(130);
    }
    interrupted = true;
    requestInterrupt(); // sets flag + SIGINTs the current child process
  });
}

async function main() {
  if (command === 'up') return await cmdUp();
  if (command === 'status') return await cmdStatus();
  if (command === 'down') return await cmdDown();
  if (command === 'rollback') return await cmdRollback();
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------
async function cmdUp() {
  const state = loadState();
  const ctx = makeCtx();
  const tui = new Tui(steps.map((s) => ({ id: s.id, title: s.title, state: 'pending', note: '' })));
  ctx.tui = tui;

  const skip = new Set();
  if (!fresh) {
    for (const [id, st] of Object.entries(state.steps ?? {})) {
      if (st === 'done') skip.add(id);
    }
  }
  for (const id of redo) skip.delete(id);

  if (skip.size > 0) {
    console.log(dim(`resuming: skipping ${skip.size} completed step(s): ${[...skip].join(', ')}`));
  }

  armInterrupt();
  tui.start();

  let failure = null;

  for (const step of steps) {
    if (interrupted) break;
    const stepState = tui.steps.find((s) => s.id === step.id);
    if (skip.has(step.id)) {
      stepState.state = 'done';
      stepState.note = 'cached';
      tui.render();
      continue;
    }
    stepState.state = 'running';
    tui.setStatus(step.title);
    tui.render();
    // env must be loaded before any step runs (steps depend on ctx.env)
    if (!ctx.env) ctx.ensureEnv();
    try {
      await runStep(step, ctx, state);
      stepState.state = 'done';
      state.steps[step.id] = 'done';
      saveState(state);
      tui.render();
    } catch (e) {
      if (e.name === 'Interrupted' || interrupted) {
        stepState.state = 'partial';
        state.steps[step.id] = 'partial';
        saveState(state);
      } else {
        stepState.state = 'failed';
        state.steps[step.id] = 'failed';
        failure = { step, e };
        saveState(state);
      }
      tui.render();
      break;
    }
  }

  tui.stop();

  if (interrupted) {
    // ask keep/rollback unless --yes
    const choice = yes ? 'k' : await promptKeep();
    if (choice === 'r') {
      console.log(dim('rolling back…'));
      await rollbackAll(ctx, state);
      console.log(ok('rollback complete. re-run `pnpm dev:up` to start over.'));
      return;
    }
    console.log(
      warn('kept current state. re-run `pnpm dev:up` to resume from where you left off.'),
    );
    return;
  }

  if (failure) {
    console.error(err(`\nstep "${failure.step.title}" failed:`));
    console.error(dim(failure.e.message));
    console.error(dim(`\nfull log: ${join(STATE_DIR, 'logs', `${failure.step.id}.log`)}`));
    console.error(dim('re-run `pnpm dev:up` to retry this step.'));
    process.exitCode = 1;
    return;
  }

  // success summary ---------------------------------------------------------
  printSummary(ctx);
}

async function runStep(step, ctx, _state) {
  const logs = [];
  ctx.bindLog(logs);
  try {
    await step.run(ctx);
    writeLog(step.id, logs);
  } catch (e) {
    writeLog(step.id, logs);
    throw e;
  }
}

import { mkdirSync, writeFileSync } from 'node:fs';
function writeLog(id, lines) {
  mkdirSync(join(STATE_DIR, 'logs'), { recursive: true });
  writeFileSync(join(STATE_DIR, 'logs', `${id}.log`), lines.join('\n') + '\n');
}

async function promptKeep() {
  const { promptKeepOrRollback } = await import('./tui.mjs');
  const answer = await promptKeepOrRollback(null);
  if (answer.startsWith('r')) return 'r';
  if (answer.startsWith('q')) return 'k';
  return 'k';
}

async function rollbackAll(ctx, state) {
  // reverse order teardown
  for (const step of [...steps].reverse()) {
    if (typeof step.rollback === 'function') {
      try {
        await step.rollback(ctx);
      } catch {
        /* continue teardown */
      }
    }
  }
  state.steps = {};
  saveState(state);
}

function printSummary(ctx) {
  const env = ctx.env ?? {};
  console.log('');
  console.log(ok(bold('  Kâtip dev stack is up.')));
  console.log('');
  console.log(`    ${bold('Chat UI')}          https://demo.localhost  (LibreChat, demo tenant)`);
  console.log(
    `    ${bold('Keycloak admin')}    https://auth.localhost  (user: ${env.KC_BOOTSTRAP_ADMIN_USER ?? 'katip-admin'})`,
  );
  console.log(`    ${bold('Mailpit')}           https://mailpit.localhost`);
  console.log(`    ${bold('Traefik dashboard')} http://127.0.0.1:9090`);
  console.log('');
  console.log(dim('    Gateway smoke passed: chat through policy-gateway → LiteLLM → mock.'));
  console.log(dim(`    Secrets: infra/env/katip.env  ·  state: .katip/setup-state.json`));
  console.log(
    dim('    Stop: pnpm dev:down  ·  Remove: pnpm dev:rollback  ·  Status: pnpm dev:status'),
  );
  console.log('');
}

// ---------------------------------------------------------------------------
// status / down / rollback
// ---------------------------------------------------------------------------
async function cmdStatus() {
  const state = loadState();
  console.log(bold('Kâtip bootstrap state'));
  for (const s of steps) {
    const st = state.steps?.[s.id] ?? 'pending';
    const icon =
      st === 'done'
        ? ok('✔')
        : st === 'partial'
          ? warn('◐')
          : st === 'failed'
            ? err('✖')
            : dim('○');
    console.log(`  ${icon} ${s.title}  ${dim(st)}`);
  }
  // service health
  console.log(dim('\nservices:'));
  const ctx = makeCtx();
  ctx.ensureEnv();
  const ce = composeEnv(ctx.config);
  try {
    const r = await tryRun(
      'docker',
      [
        'compose',
        '--env-file',
        'infra/env/katip.env',
        '-f',
        'infra/compose/platform.yml',
        '-f',
        'infra/compose/dev.yml',
        'ps',
        '--format',
        'table {{.Service}}\t{{.Status}}',
      ],
      {
        env: { ...process.env, ...ce },
      },
    );
    if (r.out.trim()) console.log(r.out.trim());
  } catch {
    console.log(dim('  (platform not running)'));
  }
  try {
    const r = await tryRun(
      'docker',
      [
        'compose',
        '--env-file',
        'infra/env/katip.env',
        '-f',
        'infra/compose/tenants/demo.yml',
        '-p',
        TENANT_PROJECT,
        'ps',
        '--format',
        'table {{.Service}}\t{{.Status}}',
      ],
      {
        env: { ...process.env, ...ce },
      },
    );
    if (r.out.trim()) console.log(r.out.trim());
  } catch {
    /* tenant not created yet */
  }
}

async function cmdDown() {
  const ctx = makeCtx();
  ctx.ensureEnv();
  const ce = composeEnv(ctx.config);
  console.log(dim('stopping tenant…'));
  await tryRun(
    'docker',
    [
      'compose',
      '--env-file',
      'infra/env/katip.env',
      '-f',
      'infra/compose/tenants/demo.yml',
      '-p',
      TENANT_PROJECT,
      'down',
      '--remove-orphans',
    ],
    {
      env: { ...process.env, ...ce },
    },
  ).catch(() => {});
  console.log(dim('stopping platform…'));
  await tryRun(
    'docker',
    [
      'compose',
      '--env-file',
      'infra/env/katip.env',
      '-f',
      'infra/compose/platform.yml',
      '-f',
      'infra/compose/dev.yml',
      'down',
      '--remove-orphans',
    ],
    {
      env: { ...process.env, ...ce },
    },
  ).catch(() => {});
  console.log(ok('stopped (data kept). `pnpm dev:up` restarts everything.'));
}

async function cmdRollback() {
  const state = loadState();
  const ctx = makeCtx();
  ctx.ensureEnv();
  if (!yes) {
    const { createInterface } = await import('node:readline');
    process.stdout.write(
      warn(
        'This removes containers, volumes and rendered files the bootstrap created. Continue? [y/N] ',
      ),
    );
    const rl = createInterface({ input: process.stdin, terminal: false });
    const answer = await new Promise((res) =>
      rl.on('line', (l) => {
        rl.close();
        res(l.trim().toLowerCase());
      }),
    );
    if (answer !== 'y' && answer !== 'yes') {
      console.log('aborted.');
      return;
    }
  }
  await rollbackAll(ctx, state);
  console.log(ok('rollback complete.'));
}

main().catch((e) => {
  console.error(err(`fatal: ${e.message}`));
  process.exit(1);
});
