// SPDX-License-Identifier: AGPL-3.0-only
// What each secret needs to rotate safely, and the order it happens in. The order, for all of
// them: write down old and new, change the store, try the new value, write the env file,
// restart what uses it, check it, and only then forget the old value.
//
// Everything that touches the world comes in through `deps`, so the order can be tested.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { deriveEnv } from './steps.mjs';
import { tenantSecretName } from './config.mjs';
import { generatorFor, parseEnvFile } from './util.mjs';

const DAY_MS = 86_400_000;
export const ROTATION_DAYS = 90;
const SLUG = /^[a-z0-9-]{3,32}$/;

const FINISH = 'pnpm secrets:rotate --resume';
const UNDO = 'pnpm secrets:rotate --abort';

const generated = (restart, extra = {}) => ({ source: 'generate', restart, ...extra });
const pgRole = (role, db, restart, extra = {}) =>
  generated(restart, { store: { type: 'pg', role, db }, ...extra });
const issued = (restart, extra = {}) => ({
  source: 'stdin',
  restart,
  after: 'Check a chat. Then revoke the old key at the provider: that is not done from here.',
  ...extra,
});

const LAGO_REFUSAL = (why) =>
  `${why}, so changing the env file alone would not rotate it. See docs/runbooks/billing.md.`;
const LAGO_ENCRYPTED =
  'Lago encrypts columns of its database with it, and a new value would make them unreadable. See docs/runbooks/billing.md.';

/** `role: null` means whoever POSTGRES_USER names. */
const PLATFORM = {
  LITELLM_MASTER_KEY: generated(['litellm', 'policy-gateway']),
  KATIP_PII_TOKEN_KEY: generated(['policy-gateway'], {
    warning:
      'Placeholders change in ongoing conversations. Where an old tool call or tool result holds an old placeholder, the gateway cannot restore it, and a user may see it in an answer. New conversations are fine, nothing is exposed, and nothing is lost. Do this out of hours, and tell companies.',
  }),
  KATIP_METRICS_TOKEN: generated(['policy-gateway', 'console-api'], {
    after:
      'If monitoring is on, run pnpm dev:up --redo=monitoring, which gives Prometheus the new token. It shows the gateway as down until then.',
  }),
  VALKEY_PASSWORD: generated(['valkey', 'policy-gateway', 'console-api']),
  KATIP_GATEWAY_DB_PASSWORD: pgRole('katip_gateway', 'governance', ['policy-gateway']),
  KATIP_CONSOLE_DB_PASSWORD: pgRole('katip_console', 'governance', ['console-api']),
  KATIP_PROVIDER_DB_PASSWORD: pgRole('katip_provider', 'governance', []),
  KATIP_PROVISIONER_KC_SECRET: generated(['identity'], {
    store: { type: 'kc-client', clientId: 'katip-provisioner' },
  }),
  KATIP_IDENTITY_TOKEN: generated(['identity', 'console-api']),
  MOCK_LLM_KEY: generated(['litellm']),
  POSTGRES_PASSWORD: pgRole(null, 'governance', []),
  KC_DB_PASSWORD: pgRole('keycloak', 'keycloak', ['keycloak'], {
    warning: 'Nobody can log in while Keycloak restarts, about a minute.',
  }),
  LITELLM_DB_PASSWORD: pgRole('litellm', 'litellm', [], {
    derive(env, value) {
      const url = (password) =>
        deriveEnv({ LITELLM_DB_PASSWORD: password, LITELLM_DATABASE_URL: 'AUTO' })
          .LITELLM_DATABASE_URL;
      return env.LITELLM_DATABASE_URL === url(env.LITELLM_DB_PASSWORD)
        ? { LITELLM_DATABASE_URL: url(value) }
        : {};
    },
  }),
  KC_BOOTSTRAP_ADMIN_PASSWORD: generated([], { store: { type: 'kc-admin' } }),
  MONGO_PASSWORD: generated(['mongodb'], {
    store: { type: 'mongo-root' },
    warning:
      'Mongo restarts, so every company loses its chats for a few seconds. Its container has to hold the new value: the backup commands read it there.',
  }),
  DEEPINFRA_API_KEY: issued(['litellm']),
  OPENROUTER_API_KEY: issued(['litellm']),
  ANTHROPIC_API_KEY: issued(['litellm']),
  GCP_VERTEX_KEY: issued(['litellm']),
  VLLM_TR_KEY: issued(['litellm']),
  KATIP_LOCAL_LLM_KEY: issued(['litellm'], {
    after: 'Check a chat with the local model. Its server holds this key, not this tool.',
  }),
  LITELLM_DATABASE_URL: {
    refuse: 'it is made from LITELLM_DB_PASSWORD. Rotate that, and this changes with it.',
  },
  KATIP_BILLING_DB_PASSWORD: pgRole('katip_billing', 'governance', ['billing-bridge']),
  LAGO_REDIS_PASSWORD: generated(['lago-redis', 'lago-api', 'lago-worker', 'lago-clock'], {
    warning:
      'Lago stops for about a minute. Usage waits in the governance DB, and nothing is lost.',
  }),
  LAGO_API_KEY: {
    refuse: LAGO_REFUSAL('Lago adds the new key at its start and keeps the old one'),
  },
  LAGO_ADMIN_PASSWORD: { refuse: LAGO_REFUSAL('Lago sets it only when it makes the user') },
  LAGO_DB_PASSWORD: { refuse: LAGO_REFUSAL("this tool doesn't change Lago's own Postgres yet") },
  LAGO_SECRET_KEY_BASE: { refuse: LAGO_REFUSAL('Lago derives its sessions from it') },
  LAGO_RSA_PRIVATE_KEY: { refuse: LAGO_REFUSAL('Lago signs its login tokens with it') },
  LAGO_ENCRYPTION_PRIMARY_KEY: { refuse: LAGO_ENCRYPTED },
  LAGO_ENCRYPTION_DETERMINISTIC_KEY: { refuse: LAGO_ENCRYPTED },
  LAGO_ENCRYPTION_KEY_DERIVATION_SALT: { refuse: LAGO_ENCRYPTED },
  // Monitoring (P1-43).
  GRAFANA_ADMIN_PASSWORD: {
    refuse:
      'Grafana sets it only at its first start and then keeps its own. Change it in Grafana (docker exec katip-grafana-1 grafana cli admin reset-admin-password), then here. See docs/runbooks/incident.md.',
  },
  KATIP_MONITOR_DB_PASSWORD: pgRole('katip_monitor', 'governance', ['postgres-exporter']),
  KATIP_MONITOR_MONGO_PASSWORD: {
    refuse:
      "pnpm dev:up sets it on Mongo's katip_monitor user every time, so change it in katip.env and run pnpm dev:up --redo=monitoring.",
  },
  KATIP_MONITOR_VALKEY_PASSWORD: generated(['valkey', 'valkey-exporter'], {
    warning: 'Valkey restarts: chats wait a few seconds. Its data is kept (AOF).',
  }),
};

const LOGOUT =
  'Everyone in this company is logged out, and signs in again. Chats are not affected.';

const CREDS_REFUSAL =
  "rotating it makes data unreadable, and there is no safe tool to re-encrypt. LibreChat v0.8.7 encrypts with it, in three formats (a fixed IV, a random IV, AES-CTR): users' own API keys and tool credentials, agent action credentials, MCP server secrets and OAuth tokens, skill sync tokens and two-factor secrets. If one has leaked, see docs/runbooks/secret-rotation.md.";

/** Every one of these recreates the company's containers. */
const TENANT = {
  GATEWAY_KEY: generated('tenant', {
    store: { type: 'gateway-key' },
    warning:
      "This company's chats fail until its LibreChat restarts, up to a few minutes. The old key may work for one more minute, as the gateway caches keys.",
  }),
  RAG_GATEWAY_KEY: generated('tenant', {
    warning: "This company's file search and chats stop while its containers restart.",
  }),
  LC_OIDC_CLIENT_SECRET: generated('tenant', {
    store: { type: 'kc-client' },
    warning: 'Login to this company fails until its LibreChat restarts. Existing sessions go on.',
  }),
  MONGO_PASSWORD: generated('tenant', {
    store: { type: 'mongo-tenant' },
    warning: "This company's chats stop while its containers restart.",
  }),
  LC_JWT_SECRET: generated('tenant', { warning: LOGOUT }),
  LC_JWT_REFRESH_SECRET: generated('tenant', { warning: LOGOUT }),
  LC_OIDC_SESSION_SECRET: generated('tenant', { warning: LOGOUT }),
  MEILI_KEY: generated('tenant', {
    warning: "This company's chats stop while its containers restart.",
  }),
  RAG_DB_PASSWORD: generated('tenant', {
    store: { type: 'pg', role: 'rag', db: 'rag', where: 'ragdb' },
    warning: "This company's chats stop while its containers restart.",
  }),
  DEMO_USER_PASSWORD: generated('tenant', {
    store: { type: 'kc-demo-users' },
    warning: "This company's chats stop while its containers restart. Dev only.",
  }),
  LC_CREDS_KEY: { refuse: CREDS_REFUSAL },
  LC_CREDS_IV: { refuse: CREDS_REFUSAL },
};

export const platformSecretNames = () => Object.keys(PLATFORM);
export const tenantSecretNames = () => Object.keys(TENANT);

/** Rotation's name for a secret, in the record and on screen. */
export const rotationId = (name, slug) => (slug ? `${slug}/${name}` : name);

const keyOf = (name, slug) => (slug ? tenantSecretName(slug, name) : name);

function recipeFor(name, slug) {
  if (slug !== undefined && slug !== null && !SLUG.test(slug)) {
    throw new Error(`not a company slug: ${slug}`);
  }
  const table = slug ? TENANT : PLATFORM;
  if (Object.hasOwn(table, name)) return table[name];
  if (!slug && Object.hasOwn(TENANT, name)) {
    throw new Error(`${name} belongs to a company: add --tenant <slug>`);
  }
  if (slug && Object.hasOwn(PLATFORM, name)) {
    throw new Error(`${name} is not a company's secret: leave out --tenant`);
  }
  throw new Error(`no such secret: ${name}. pnpm secrets:rotate --list shows them all`);
}

// ---- values -----------------------------------------------------------------------------------

/**
 * A new value in the format this secret's generator makes: letters, digits, `-` and `_`, which
 * mean nothing in a URL. Never a leading `-`, which a server's start options could take for one
 * of their own (Valkey's password is one of those).
 */
export function generateValue(key) {
  const generate = generatorFor(key);
  for (;;) {
    const value = generate();
    if (!value.startsWith('-')) return value;
  }
}

/** A value someone gives us goes into an env file that compose reads and interpolates. */
export function checkSuppliedValue(value) {
  if (!value) throw new Error('no value given, and a key is never cleared: nothing changed');
  if (value.length < 8) throw new Error('that value is too short to be a key: nothing changed');
  if (!/^[\x21-\x7e]+$/.test(value) || /[#$'"\\`]/.test(value)) {
    throw new Error(
      'that value has a space, or one of # $ \' " \\ ` which an env file would change: nothing changed',
    );
  }
  return value;
}

// ---- files ------------------------------------------------------------------------------------

/** Replaces a file in one step, never readable by anyone else, and never half written. */
export function writeFileAtomic600(path, content) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Changes these lines of an env file and no others. Every key must already be there. */
export function updateEnvFile(path, updates) {
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const at = lines.flatMap((l, i) => (l.trim().startsWith(`${key}=`) ? [i] : []));
    if (at.length !== 1) {
      throw new Error(`${key} should be on one line of its env file, and is on ${at.length}`);
    }
    lines[at[0]] = `${key}=${value}`;
  }
  writeFileAtomic600(path, lines.join('\n'));
  const written = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(updates)) {
    if (written[key] !== value) throw new Error(`${key} did not read back from its env file`);
  }
}

/** The rotation in progress, on disk. Holds both values, as the old one can't be got back. */
export const fileJournal = (path) => ({
  read: () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null),
  write: (entry) => writeFileAtomic600(path, `${JSON.stringify(entry, null, 2)}\n`),
  clear: () => rmSync(path, { force: true }),
});

export const fileRotations = (path, atomicWrite = writeFileAtomic600) => ({
  read: () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}),
  /** By name and date, never a value. */
  record(id, date) {
    const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    atomicWrite(path, `${JSON.stringify({ ...all, [id]: date }, null, 2)}\n`);
  },
});

// ---- the list ---------------------------------------------------------------------------------

/** Each secret: can it rotate, when did it last, and is it due. Holds names and dates only. */
export function listSecrets({ platformEnv, slugs, tenantEnv, rotations, now = new Date() }) {
  const row = (name, recipe, slug, env) => {
    const id = rotationId(name, slug);
    const last = rotations[id] ?? null;
    const value = env[keyOf(name, slug)];
    const isSet = Boolean(value) && value !== 'AUTO';
    const canRotate = !recipe.refuse;
    const overdue =
      canRotate &&
      isSet &&
      (!last || now.getTime() - new Date(last).getTime() > ROTATION_DAYS * DAY_MS);
    return {
      id,
      rotate: recipe.refuse
        ? 'refuses'
        : recipe.source === 'stdin'
          ? 'new value from the provider'
          : 'yes',
      isSet,
      lastRotated: last,
      overdue,
    };
  };
  return [
    ...Object.entries(PLATFORM).map(([name, recipe]) => row(name, recipe, null, platformEnv)),
    ...slugs.flatMap((slug) =>
      Object.entries(TENANT).map(([name, recipe]) => row(name, recipe, slug, tenantEnv(slug))),
    ),
  ];
}

// ---- rotating ---------------------------------------------------------------------------------

const unfinished = (id, what, cause) =>
  new Error(
    `${id} is not finished: ${what}\n  ${cause}\n` +
      `Old and new values are kept in infra/env/rotation-pending.env.\n` +
      `To finish: ${FINISH}\nTo go back to the old value: ${UNDO}`,
  );

const message = (e) => e.message.trim();

const targetOf = (entry) => ({ recipe: recipeFor(entry.name, entry.slug), slug: entry.slug });

const storeOf = (recipe, deps) => (recipe.store ? deps.stores[recipe.store.type] : null);

const primary = (entry, values) => values[keyOf(entry.name, entry.slug)];

/** true or false from the store. null if it can't be tried, or the attempt itself failed. */
const tryValue = async (store, target, value) => {
  try {
    return await store.verify(target, value);
  } catch {
    return null;
  }
};

/** Puts the new value in the store. Undoes it, or says how to, if it doesn't work there. */
async function changeStore(entry, deps) {
  const target = targetOf(entry);
  const store = storeOf(target.recipe, deps);
  if (!store) return;
  const id = rotationId(entry.name, entry.slug);
  const oldValue = primary(entry, entry.old);
  const newValue = primary(entry, entry.new);

  // On a resume, the first attempt may have got this far before it stopped.
  if ((await tryValue(store, target, newValue)) === true) return;
  deps.log(`${id}: changing it where it's stored`);

  let reason;
  try {
    await store.set(target, { auth: oldValue, value: newValue });
    if ((await tryValue(store, target, newValue)) !== false) return;
    reason = 'the new value was not accepted after the change';
  } catch (e) {
    // A refused change leaves the old value. `null` means we can't tell, and it's one statement.
    if ((await tryValue(store, target, newValue)) !== true) {
      deps.journal.clear();
      throw new Error(
        `${id}: nothing changed, and the old value is still in use.\n  ${message(e)}`,
      );
    }
    reason = message(e);
  }
  await putStoreBack(entry, deps, reason);
}

/** After a failed change: the old value goes back, and nothing is left to do. */
async function putStoreBack(entry, deps, reason) {
  const id = rotationId(entry.name, entry.slug);
  try {
    await restoreStore(entry, deps);
  } catch (e) {
    throw unfinished(id, 'the change failed, and so did putting the old value back.', message(e));
  }
  deps.journal.clear();
  throw new Error(`${id}: the old value was put back, and is in use.\n  ${reason}`);
}

async function restoreStore(entry, deps) {
  const target = targetOf(entry);
  const store = storeOf(target.recipe, deps);
  if (!store) return;
  const oldValue = primary(entry, entry.old);
  const newValue = primary(entry, entry.new);
  if ((await tryValue(store, target, oldValue)) === true) return;
  await store.set(target, { auth: newValue, value: oldValue });
  if ((await tryValue(store, target, oldValue)) === false) {
    throw new Error('the store did not accept the old value after it was put back');
  }
}

async function restartAndCheck(entry, deps) {
  const target = targetOf(entry);
  const store = storeOf(target.recipe, deps);
  await deps.restart(target);
  await deps.check(target);
  const value = primary(entry, entry.new);
  if (store && (await tryValue(store, target, value)) === false) {
    throw new Error('the store does not accept the new value after the restart');
  }
}

/** Carries a rotation on from whichever phase it reached. */
async function advance(entry, deps) {
  const id = rotationId(entry.name, entry.slug);
  const save = (phase) => {
    entry.phase = phase;
    deps.journal.write(entry);
  };

  if (entry.phase === 'prepared') {
    await changeStore(entry, deps);
    save('stored');
  }
  if (entry.phase === 'stored') {
    try {
      deps.writeEnv(entry.slug, entry.new);
    } catch (e) {
      await putStoreBack(entry, deps, `the env file could not be written: ${message(e)}`);
    }
    save('written');
  }
  if (entry.phase === 'written') {
    try {
      await restartAndCheck(entry, deps);
    } catch (e) {
      throw unfinished(
        id,
        'the new value is stored and in the env file, but the restart or its check failed.',
        message(e),
      );
    }
  }

  const { after } = targetOf(entry).recipe;
  deps.rotations.record(id, deps.now().toISOString().slice(0, 10));
  deps.journal.clear();
  deps.log(`${id}: rotated and checked.`);
  if (after) deps.log(after);
  deps.log('Earlier secrets backups now hold the old value: take a new one (pnpm secrets:backup).');
}

/** `name` is a secret's short name. `slug` is set for a company's secret. */
export async function rotate({ name, slug = null }, deps) {
  const recipe = recipeFor(name, slug);
  const id = rotationId(name, slug);
  if (recipe.refuse) throw new Error(`${id} cannot be rotated from here: ${recipe.refuse}`);

  const running = deps.journal.read();
  if (running) {
    throw new Error(
      `the rotation of ${rotationId(running.name, running.slug)} is not finished. To finish: ${FINISH}. To go back: ${UNDO}.`,
    );
  }

  const env = deps.readEnv(slug);
  const key = keyOf(name, slug);
  const oldValue = env[key];
  if (!oldValue || oldValue === 'AUTO') {
    throw new Error(
      recipe.source === 'stdin'
        ? `${id} is not set. Setting a key for the first time changes which model answers: put it in infra/env/katip.env and run pnpm dev:up.`
        : `${id} has no value yet: run pnpm dev:up first.`,
    );
  }

  const newValue =
    recipe.source === 'stdin' ? checkSuppliedValue(await deps.readValue(id)) : generateValue(key);
  if (newValue === oldValue)
    throw new Error(`${id}: that is the value it has now. Nothing changed.`);

  if (recipe.warning && !(await deps.confirm(recipe.warning))) {
    throw new Error(`${id}: not confirmed, so nothing changed.`);
  }

  const target = { recipe, slug };
  await deps.preflight(target);
  const store = storeOf(recipe, deps);
  if (store && (await store.verify(target, oldValue)) === false) {
    throw new Error(
      `${id}: nothing changed. Its store does not accept the value in the env file, so they were already out of step, or the service is down. Fix that first.`,
    );
  }

  const derived = recipe.derive?.(env, newValue) ?? {};
  const pick = (keys) => Object.fromEntries(keys.map((k) => [k, env[k]]));
  const entry = {
    name,
    slug,
    phase: 'prepared',
    startedAt: deps.now().toISOString(),
    old: { [key]: oldValue, ...pick(Object.keys(derived)) },
    new: { [key]: newValue, ...derived },
  };
  deps.journal.write(entry);
  await advance(entry, deps);
}

/** Finishes whatever the last rotation left, and needs nothing else from the person. */
export async function resume(deps) {
  const entry = deps.journal.read();
  if (!entry) throw new Error('no rotation is in progress.');
  await advance(entry, deps);
}

/** Puts the old value back everywhere the rotation reached. */
export async function abort(deps) {
  const entry = deps.journal.read();
  if (!entry) throw new Error('no rotation is in progress.');
  const id = rotationId(entry.name, entry.slug);
  const target = targetOf(entry);
  try {
    await restoreStore(entry, deps);
    // Also from `stored`: it may have stopped just after writing the file.
    if (entry.phase !== 'prepared') deps.writeEnv(entry.slug, entry.old);
    if (entry.phase === 'written') {
      await deps.restart(target);
      await deps.check(target);
    }
  } catch (e) {
    throw new Error(
      `${id}: going back failed, so old and new values are kept in infra/env/rotation-pending.env.\n  ${message(e)}\nTo try again: ${UNDO}`,
    );
  }
  deps.journal.clear();
  deps.log(`${id}: back on the old value, and checked.`);
}
