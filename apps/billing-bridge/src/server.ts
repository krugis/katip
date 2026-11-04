// SPDX-License-Identifier: AGPL-3.0-only
// The service: a billing run at start and then every BILLING_RUN_EVERY_MINUTES (LLD-06 §1).
// /healthz answers while the process lives; /readyz fails while the last run had errors.
import { createServer } from 'node:http';
import { runOnce, type RunResult } from './bridge.js';
import { loadConfig } from './config.js';
import { realDeps } from './deps.js';

const config = loadConfig();
const deps = await realDeps(config);
let last: { at: string; result: RunResult | null } | null = null;
let failure: string | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await runOnce(deps);
    last = { at: new Date().toISOString(), result };
    failure =
      result && result.errors.length > 0 ? `${result.errors.length} companies failed` : null;
    deps.log.info(
      {
        tenants: result?.tenants.length ?? 0,
        skipped: result?.skipped.length ?? 0,
        errors: result?.errors.length ?? 0,
        locked: result === null,
      },
      'billing run done',
    );
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    deps.log.error({ err: failure }, 'billing run failed');
  } finally {
    running = false;
  }
}

const server = createServer((req, res) => {
  const ready = req.url === '/readyz' ? failure === null : true;
  if (req.url !== '/healthz' && req.url !== '/readyz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ready ? 'ok' : 'failing', failure, last }));
});
server.listen(config.PORT, '0.0.0.0');

void tick();
const timer = setInterval(() => void tick(), config.BILLING_RUN_EVERY_MINUTES * 60_000);

const stop = async () => {
  clearInterval(timer);
  server.close();
  await deps.store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
