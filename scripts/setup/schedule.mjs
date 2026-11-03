// SPDX-License-Identifier: AGPL-3.0-only
// The daily job in this user's crontab (tracker P1-65). It needs Docker on the host, so it
// can't live in a container without giving one the Docker socket. Each checkout has its own
// line, so installing never touches anything else in the crontab.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { LOG_DIR, ROOT, STATE_DIR } from './util.mjs';

const markerFor = (root) => `# katip-daily ${root}`;

/** The line for one checkout. Cron gives a bare environment, so it spells out what it needs. */
export function dailyLine({ root, node, at }) {
  if (/[%"\n]/.test(root) || /[%"\n]/.test(node)) {
    throw new Error('the daily job cannot be scheduled from a path holding % or "');
  }
  const [hour, minute] = at.split(':').map(Number);
  const path = `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`;
  return (
    `${minute} ${hour} * * * cd "${root}" && PATH="${path}" flock -n .katip/daily.lock ` +
    `"${node}" scripts/setup/tenant-cli.mjs daily > .katip/logs/daily.log 2>&1 ${markerFor(root)}`
  );
}

/** The crontab without this checkout's line, and with `line` if there is one. */
export function crontabWith(existing, root, line) {
  const kept = existing.split('\n').filter((l) => l !== '' && !l.endsWith(markerFor(root)));
  return `${[...kept, ...(line ? [line] : [])].join('\n')}\n`;
}

const readCrontab = () => {
  try {
    return execFileSync('crontab', ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // Exit 1 is "no crontab yet". No crontab program at all is the caller's to report.
    if (e.code === 'ENOENT') throw e;
    return '';
  }
};

const writeCrontab = (text) => execFileSync('crontab', ['-'], { input: text });

/** Only when the config asks for it. False otherwise, or when this machine has no cron. */
export function installSchedule(config) {
  const at = config.jobs?.daily_at;
  if (!at) {
    removeSchedule();
    return false;
  }
  try {
    const existing = readCrontab();
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true });
    writeCrontab(
      crontabWith(existing, ROOT, dailyLine({ root: ROOT, node: process.execPath, at })),
    );
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

export function removeSchedule() {
  try {
    const existing = readCrontab();
    if (existing.includes(markerFor(ROOT))) writeCrontab(crontabWith(existing, ROOT, null));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/** The command a crontab line would run, for the live test. Nothing is installed. */
export function dailyCommand() {
  const line = dailyLine({ root: ROOT, node: process.execPath, at: '03:30' });
  return line.split(/\s+/).slice(5).join(' ');
}

export const dailyLogPath = () => join(LOG_DIR, 'daily.log');
