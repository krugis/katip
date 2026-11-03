#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Kâtip one-stop bootstrap (tracker P0-12…P0-16). See scripts/setup/ modules.
 *
 *   pnpm dev:up        run or resume the bootstrap (default)
 *   pnpm dev:status    show step state + service health
 *   pnpm dev:down      stop all services (data and state kept)
 *   pnpm dev:rollback  remove everything the bootstrap created (rollback-guard.mjs)
 *
 * Flags: --fresh (ignore state), --redo=<ids> (force steps), --skip=<ids> (leave steps out),
 * --yes (no prompts), --destroy-data <project> (rollback, when real data may exist)
 */
import { join } from 'node:path';
import process from 'node:process';
import { adoptTenantSecretsFromEnvFile, knownTenantSlugs } from './tenants.mjs';
import {
  ROOT,
  STATE_DIR,
  clearInterruptPending,
  ensureEnvFile,
  loadState,
  run,
  saveState,
  tryRun,
  requestInterrupt,
} from './util.mjs';
import { composeEnv, configHash, identityOf, loadConfig } from './config.mjs';
import {
  AUTO_KEYS,
  KEEP_ON_CONFIG_CHANGE,
  SERVICE_STEPS,
  allTenants,
  deriveEnv,
  loadAllTenantSecrets,
  removeLocalLlmRelay,
  platformComposeArgs,
  renderAll,
  steps,
  tenantComposeArgs,
} from './steps.mjs';
import { containersOf } from './backups.mjs';
import {
  destroyDataFlag,
  leftovers,
  readSnapshot,
  runRollback,
  teardown,
} from './rollback-guard.mjs';
import { Tui, askLine, bold, dim, err, ok, warn } from './tui.mjs';

const argv = process.argv.slice(2);
const command = ['up', 'status', 'down', 'rollback'].includes(argv[0]) ? argv[0] : 'up';
const fresh = argv.includes('--fresh');
const stepList = (flag) =>
  (argv.find((a) => a.startsWith(flag))?.slice(flag.length) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const redo = stepList('--redo=');
const skipped = stepList('--skip=');
const yes = argv.includes('--yes');

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------
function makeCtx() {
  const config = loadConfig();
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
      adoptTenantSecretsFromEnvFile(join(ROOT, 'infra'));
      const r = ensureEnvFile(AUTO_KEYS, deriveEnv);
      loadAllTenantSecrets({ config, infra: join(ROOT, 'infra'), env: r.env });
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
  ctx.ensureEnv();
  if (!applyConfigChanges(ctx, state)) return;
  const tui = new Tui(steps.map((s) => ({ id: s.id, title: s.title, state: 'pending', note: '' })));
  ctx.tui = tui;

  const skip = new Set();
  if (!fresh) {
    for (const [id, st] of Object.entries(state.steps ?? {})) {
      if (st === 'done') skip.add(id);
    }
  }
  for (const id of redo) skip.delete(id);
  for (const id of skipped) skip.add(id);

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
      // The same check as dev:rollback. Commands report Interrupted while the flag is up.
      clearInterruptPending();
      const outcome = await safeRollback(ctx, state, {
        interactive: Boolean(process.stdin.isTTY),
      });
      if (outcome === 'done') {
        console.log(ok('rollback complete. re-run `pnpm dev:up` to start over.'));
        return;
      }
      if (outcome === 'failed') return;
    }
    console.log(
      warn('kept current state. re-run `pnpm dev:up` to resume from where you left off.'),
    );
    process.exitCode ||= 130;
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
  delete state.recreateAfterChange;
  saveState(state);
  printSummary(ctx);
}

/**
 * Compares the config + env with the last run, and marks what must re-apply if
 * they changed. False when this run must stop.
 */
function applyConfigChanges(ctx, state) {
  const anyDone = Object.values(state.steps ?? {}).includes('done');
  const identity = identityOf(ctx.config);
  if (!fresh && anyDone && state.identity) {
    const { project, slugs = [state.identity.slug] } = state.identity;
    const removed = slugs.filter((s) => !identity.slugs.includes(s));
    if (project !== identity.project || removed.length > 0) {
      console.error(
        err(
          `project.name changed or a tenant was removed (${project}: ${slugs.join(', ')} → ${identity.project}: ${identity.slugs.join(', ')}), and the running stack can't be changed that way.`,
        ),
      );
      console.error(dim('Restore the old values, run `pnpm dev:rollback`, then change them.'));
      process.exitCode = 1;
      return false;
    }
  }
  const hash = configHash();
  if (!fresh && anyDone && state.configHash && state.configHash !== hash) {
    console.log(dim('katip.config.yaml or katip.env changed: re-applying.'));
    for (const id of Object.keys(state.steps)) {
      if (!KEEP_ON_CONFIG_CHANGE.has(id)) delete state.steps[id];
    }
    state.recreateAfterChange = true;
  }
  ctx.configChanged = Boolean(state.recreateAfterChange);
  state.configHash = hash;
  state.identity = identity;
  saveState(state);
  return true;
}

async function runStep(step, ctx, _state) {
  const logs = [];
  ctx.bindLog(logs);
  try {
    await step.run(ctx);
    writeLog(step.id, logs);
  } catch (e) {
    writeLog(step.id, [...logs, `FAILED: ${e.message}`]);
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

/** Removes everything, and returns what failed. A step may already be gone either way. */
async function rollbackAll(ctx, state) {
  const docker = (args) => run('docker', args);
  // Compose needs its files to know the volumes, and an earlier attempt may have removed them.
  try {
    renderAll(ctx);
  } catch (e) {
    console.error(warn(`could not render the compose files: ${e.message}`));
  }
  const failures = await teardown(steps, ctx, () => leftovers(docker, ctx.config.project.name));
  state.steps = {};
  delete state.configHash;
  delete state.identity;
  delete state.recreateAfterChange;
  saveState(state);
  return failures;
}

/** Sets a non-zero exit unless it's done, or the person simply said no. */
async function safeRollback(ctx, state, options) {
  const project = ctx.config.project.name;
  const outcome = await runRollback({
    project,
    options,
    deps: {
      config: ctx.config,
      readSnapshot: () =>
        readSnapshot(
          (args) => run('docker', args),
          project,
          containersOf(ctx.config),
          knownTenantSlugs(ctx.infra),
        ),
      teardown: () => rollbackAll(ctx, state),
      ask: askLine,
      print: (line) => console.log(line),
      printError: (line) => console.error(err(line)),
    },
  });
  if (outcome === 'refused' || outcome === 'failed') process.exitCode = 1;
  return outcome;
}

function printSummary(ctx) {
  const env = ctx.env ?? {};
  const base = ctx.config.project.base_domain;
  console.log('');
  console.log(ok(bold('  Kâtip dev stack is up.')));
  console.log('');
  for (const t of allTenants(ctx)) {
    console.log(
      `    ${bold('Chat UI')}          https://${t.slug}.${base}  (LibreChat, ${t.slug} tenant)`,
    );
  }
  console.log(
    `    ${bold('Keycloak admin')}    https://auth.${base}  (user: ${env.KC_BOOTSTRAP_ADMIN_USER ?? 'katip-admin'})`,
  );
  console.log(`    ${bold('Mailpit')}           https://mailpit.${base}`);
  console.log(`    ${bold('Traefik dashboard')} http://127.0.0.1:9090`);
  console.log('');
  console.log(dim('    Gateway smoke passed: chat through policy-gateway → LiteLLM → mock.'));
  console.log(
    dim(
      `    Demo login: user@<tenant>.localhost, password KATIP_T_<TENANT>_DEMO_USER_PASSWORD in infra/env/tenants/<tenant>.secrets.env; MFA enrolment at first login.`,
    ),
  );
  console.log(
    dim(`    Secrets: infra/env/katip.env, infra/env/tenants/  ·  state: .katip/setup-state.json`),
  );
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
      [...platformComposeArgs(), 'ps', '--format', 'table {{.Service}}\t{{.Status}}'],
      {
        env: { ...process.env, ...ce },
      },
    );
    if (r.out.trim()) console.log(r.out.trim());
  } catch {
    console.log(dim('  (platform not running)'));
  }
  for (const t of allTenants(ctx)) {
    try {
      const r = await tryRun(
        'docker',
        [...tenantComposeArgs(ctx.config, t), 'ps', '--format', 'table {{.Service}}\t{{.Status}}'],
        {
          env: { ...process.env, ...ce },
        },
      );
      if (r.out.trim()) console.log(r.out.trim());
    } catch {
      /* tenant not created yet */
    }
  }
}

async function cmdDown() {
  const ctx = makeCtx();
  ctx.ensureEnv();
  const ce = composeEnv(ctx.config);
  console.log(dim('stopping tenants…'));
  for (const t of allTenants(ctx)) {
    await tryRun('docker', [...tenantComposeArgs(ctx.config, t), 'down', '--remove-orphans'], {
      env: { ...process.env, ...ce },
    }).catch(() => {});
  }
  await removeLocalLlmRelay(ctx);
  console.log(dim('stopping platform…'));
  await tryRun('docker', [...platformComposeArgs(), 'down', '--remove-orphans'], {
    env: { ...process.env, ...ce },
  }).catch(() => {});
  const state = loadState();
  for (const id of SERVICE_STEPS) delete state.steps?.[id];
  saveState(state);
  console.log(ok('stopped (data kept). `pnpm dev:up` restarts everything.'));
}

async function cmdRollback() {
  const state = loadState();
  const ctx = makeCtx();
  ctx.ensureEnv();
  const outcome = await safeRollback(ctx, state, {
    yes,
    destroyData: destroyDataFlag(argv),
    interactive: Boolean(process.stdin.isTTY),
  });
  if (outcome === 'done') console.log(ok('rollback complete.'));
}

main().catch((e) => {
  console.error(err(`fatal: ${e.message}`));
  process.exit(1);
});
