// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../config.mjs';
import { crontabWith, dailyLine } from '../schedule.mjs';

const root = '/home/a/katip';
const line = dailyLine({ root, node: '/opt/node/bin/node', at: '03:30' });

describe('the daily job in the crontab', () => {
  it('runs at the configured time, from the checkout, one at a time', () => {
    expect(line.startsWith('30 3 * * * cd "/home/a/katip" && ')).toBe(true);
    expect(line).toContain('flock -n .katip/daily.lock');
    expect(line).toContain('"/opt/node/bin/node" scripts/setup/tenant-cli.mjs daily');
    expect(line).toContain('PATH="/opt/node/bin:');
  });

  it('refuses a path cron would misread', () => {
    expect(() => dailyLine({ root: '/home/a/100%', node: '/n', at: '03:30' })).toThrow(/%/);
  });

  it('leaves everything else in the crontab alone', () => {
    const other = '0 1 * * * /usr/bin/backup # mine';
    expect(crontabWith(`${other}\n`, root, line)).toBe(`${other}\n${line}\n`);
  });

  it('replaces its own line rather than adding another', () => {
    const newer = dailyLine({ root, node: '/opt/node/bin/node', at: '04:00' });
    expect(crontabWith(`${line}\n`, root, newer)).toBe(`${newer}\n`);
  });

  it("does not touch another checkout's line", () => {
    const fresh = dailyLine({ root: '/home/a/katip-fresh', node: '/n', at: '03:30' });
    expect(crontabWith(`${fresh}\n${line}\n`, root, null)).toBe(`${fresh}\n`);
  });
});

describe('jobs.daily_at', () => {
  const errorsFor = (daily_at) => validateConfig({ jobs: { daily_at } }).join('\n');
  it.each(['03:30', '00:00', '23:59'])('accepts %s', (at) => {
    expect(errorsFor(at)).not.toContain('jobs.daily_at');
  });
  it.each(['3:30', '24:00', '03:60', 'nightly'])('refuses %s', (at) => {
    expect(errorsFor(at)).toContain('jobs.daily_at');
  });
});
