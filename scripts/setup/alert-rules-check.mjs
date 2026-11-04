#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:alert-rules (P1-43): promtool checks every rule file and runs its unit tests, and
 * amtool checks Alertmanager's rendered config, in throwaway containers of the pinned images with
 * no network. Needs Docker, and nothing of the running stack.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { INFRA } from './util.mjs';

const config = loadConfig();
const { prometheus, alertmanager } = config.monitoring.images;
const dir = join(INFRA, 'monitoring', 'prometheus');
const run = (args) =>
  execFileSync('docker', ['run', '--rm', '--network', 'none', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const tmp = mkdtempSync(join(tmpdir(), 'katip-am-'));
try {
  console.log(
    run([
      '-v',
      `${dir}:/m:ro`,
      '--entrypoint',
      'promtool',
      prometheus,
      'check',
      'rules',
      '/m/rules/katip.yml',
      '/m/inactive/backups.yml',
    ]),
  );
  console.log(
    run([
      '-v',
      `${dir}:/m:ro`,
      '-w',
      '/m/tests',
      '--entrypoint',
      'promtool',
      prometheus,
      'test',
      'rules',
      'katip.test.yml',
    ]),
  );
  const am = readFileSync(
    join(INFRA, 'monitoring', 'alertmanager', 'alertmanager.tmpl.yml'),
    'utf8',
  )
    .replaceAll('%%ALERT_EMAIL%%', config.monitoring.alert_email)
    .replaceAll('%%BASE_DOMAIN%%', config.project.base_domain);
  writeFileSync(join(tmp, 'alertmanager.yml'), am, { mode: 0o644 });
  // amtool runs as nobody in its image; the file holds no secret.
  chmodSync(tmp, 0o755);
  console.log(
    run([
      '-v',
      `${tmp}:/a:ro`,
      '--entrypoint',
      'amtool',
      alertmanager,
      'check-config',
      '/a/alertmanager.yml',
    ]),
  );
  console.log('alert rules, their tests and Alertmanager config: OK');
} catch (e) {
  console.error(e.stdout ?? '', e.stderr ?? e.message);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
