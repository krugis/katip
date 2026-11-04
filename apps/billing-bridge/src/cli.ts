// SPDX-License-Identifier: AGPL-3.0-only
// Run in billing-bridge's container, which is on both the backend and Lago's network:
//   docker compose exec billing-bridge node dist/cli.js <command>
//   setup                       create Lago's metrics and plan, or check them (P1-36)
//   attach --slug S [--email E] [--since ISO]
//                               give a company its Lago customer and subscription, billed from
//                               the start of this hour, or of the hour --since names
//   run                         one billing run now, as the service does each hour
//   reconcile                   a run, then compare usage_events, what was sent and Lago (LLD-06 §7)
// Each prints one line starting `billing-result=` with JSON, for scripts/setup to read.
import { attachTenant, runOnce } from './bridge.js';
import { ensureCatalog } from './catalog.js';
import { loadConfig } from './config.js';
import { realDeps } from './deps.js';
import { reconcileTenant } from './reconcile.js';

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const deps = await realDeps(loadConfig());
let ok = true;
try {
  let result: unknown;
  if (command === 'setup') {
    result = await ensureCatalog(deps.lago, deps.catalog);
  } else if (command === 'attach') {
    const slug = flag('slug');
    if (!slug) throw new Error('attach needs --slug');
    const email = flag('email');
    const since = flag('since');
    if (since && Number.isNaN(Date.parse(since))) throw new Error('--since needs an ISO time');
    result = await attachTenant(deps, slug, {
      ...(email ? { email } : {}),
      ...(since ? { since: new Date(since) } : {}),
    });
  } else if (command === 'run') {
    result = await runOnce(deps);
    ok = result !== null && (result as { errors: unknown[] }).errors.length === 0;
  } else if (command === 'reconcile') {
    const run = await runOnce(deps);
    const reports = [];
    for (const t of await deps.store.tenants()) {
      if (t.status !== 'active') continue;
      const r = await reconcileTenant(deps, t);
      if (r) reports.push(r);
    }
    ok = run !== null && run.errors.length === 0 && reports.every((r) => r.ok);
    result = { run, reports };
  } else {
    throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
  console.log(`billing-result=${JSON.stringify(result)}`);
} catch (e) {
  ok = false;
  console.error(e instanceof Error ? e.message : e);
} finally {
  await deps.store.close();
}
process.exit(ok ? 0 : 1);
