// SPDX-License-Identifier: AGPL-3.0-only
// What `pnpm dev:rollback` would destroy, and whether it may (P1-71). The rule:
//
// A company is test data only if it's listed under `tenants:` in katip.config.yaml, and every
// user in the governance database and every LibreChat account is one the bootstrap seeds, and
// every chat belongs to one of them. The whole install is test data only if every company is,
// the base domain is a .localhost one, and all of it could be read. Anything else may be real.
// A company that has been purged holds nothing, so it doesn't count: the e2e tests leave those.
import { identityInput } from './config.mjs';

/** Reserved names (RFC 2606, RFC 6761). Nobody's real mailbox can be there. */
const RESERVED_DOMAIN = /\.(localhost|test|example|invalid)$|^example\.(com|net|org)$/;
const isReservedDomain = (email) => RESERVED_DOMAIN.test(email.split('@').pop().toLowerCase());

/** Who the bootstrap creates for a listed company. A real admin email is not one of them. */
export function seededEmails(config, t) {
  const { users, smokeEmail } = identityInput(config, t);
  const emails = ['demo@example.com', smokeEmail, ...users.map((u) => u.email)];
  if (isReservedDomain(t.admin_email)) emails.push(t.admin_email);
  return new Set(emails.map((e) => e.toLowerCase()));
}

/** Holds no company data, so it doesn't mean an install exists. */
const CACHE_VOLUME = /_(valkey|traefik-certs)$/;

/** What a purge leaves in `users` (anonymiseTenant in apps/provisioner). */
const ANONYMISED = '@deleted.invalid';

const isDemoDomain = (domain) => domain === 'localhost' || domain.endsWith('.localhost');

function assessCompany(config, slug, { row, db, hasSecrets, mongoRead }) {
  const users = row?.users ?? [];
  const accounts = db?.users ?? [];
  const chats = db?.chats ?? 0;
  if (
    row?.status === 'deleted' &&
    mongoRead &&
    !db &&
    !hasSecrets &&
    users.every((u) => u.email?.endsWith(ANONYMISED))
  ) {
    return { slug, status: 'purged', users: 0, accounts: 0, chats: 0, why: [] };
  }
  const why = [];
  const t = config.tenants.find((c) => c.slug === slug);
  if (!t) {
    why.push('not listed in katip.config.yaml');
  } else {
    const seeded = seededEmails(config, t);
    const isSeeded = (u) => seeded.has(String(u.email ?? '').toLowerCase());
    const otherUsers = users.filter((u) => !isSeeded(u)).length;
    if (otherUsers > 0) why.push(`${otherUsers} user(s) the bootstrap did not seed`);
    const otherAccounts = accounts.filter((u) => !isSeeded(u)).length;
    if (otherAccounts > 0) why.push(`${otherAccounts} LibreChat account(s) not seeded`);
    const seededIds = new Set(accounts.filter(isSeeded).map((u) => u.id));
    if ((db?.chatOwners ?? []).some((owner) => !seededIds.has(owner))) {
      why.push('chats that belong to someone not seeded');
    }
  }
  return {
    slug,
    status: row?.status ?? 'no row',
    users: users.length,
    accounts: accounts.length,
    chats,
    why,
  };
}

/**
 * Applies the rule to what readSnapshot found. `governance` and `mongo` are null when they
 * couldn't be read, and `volumes` is null when Docker couldn't. Verdict: empty, demo or real.
 */
export function assessData({ volumes, governance, mongo, hostSlugs = [], problems = [] }, config) {
  const unreadable = [...problems];
  const dataVolumes = volumes?.filter((v) => !CACHE_VOLUME.test(v)) ?? null;
  const installed = dataVolumes === null || dataVolumes.length > 0;
  if (volumes === null) unreadable.push('could not ask Docker which volumes exist');
  if (installed && volumes !== null && governance === null) {
    unreadable.push('could not read the governance database');
  }
  if (installed && volumes !== null && mongo === null) unreadable.push('could not read Mongo');

  const rows = new Map((governance ?? []).map((r) => [r.slug, r]));
  const dbs = new Map((mongo ?? []).map((d) => [d.db.slice('lc_'.length), d]));
  const slugs = [...new Set([...rows.keys(), ...dbs.keys(), ...hostSlugs])].sort();
  const companies = slugs.map((slug) =>
    assessCompany(config, slug, {
      row: rows.get(slug),
      db: dbs.get(slug),
      hasSecrets: hostSlugs.includes(slug),
      mongoRead: mongo !== null,
    }),
  );

  const reasons = [...unreadable];
  if (installed && !isDemoDomain(config.project.base_domain)) {
    reasons.push(`the base domain is ${config.project.base_domain}, not a .localhost one`);
  }
  for (const c of companies) {
    if (c.why.length > 0) reasons.push(`${c.slug}: ${c.why.join('; ')}`);
  }
  const holdsNothing = companies.every((c) => c.users + c.accounts + c.chats === 0);
  let verdict = 'demo';
  if (reasons.length > 0) verdict = 'real';
  else if (!installed || holdsNothing) verdict = 'empty';
  return { verdict, reasons, unreadable, companies };
}

/** What the person sees before anything is deleted. Counts and slugs only, never an email. */
export function describeData({ verdict, reasons, unreadable, companies }, project) {
  const lines = [`What a rollback of project "${project}" would delete:`];
  if (companies.length === 0) lines.push('  no companies found');
  const width = Math.max(4, ...companies.map((c) => c.slug.length));
  for (const c of companies) {
    const label =
      c.status === 'purged' ? 'already purged' : c.why.length > 0 ? 'REAL' : 'test data';
    lines.push(
      `  ${c.slug.padEnd(width)}  ${c.status.padEnd(9)}  users: ${c.users}, LibreChat accounts: ${c.accounts}, chats: ${c.chats}  (${label})`,
    );
  }
  for (const u of unreadable) lines.push(`  ${u}: treating this as real data`);
  lines.push(
    '  Also: every uploaded file and vector, the Keycloak database with its users and MFA, the audit log and usage records, every company secret. No backup exists unless you made one.',
  );
  if (verdict === 'real') {
    lines.push('This may be real data:');
    for (const r of reasons) lines.push(`  - ${r}`);
  } else if (verdict === 'empty') {
    lines.push('No company data was found.');
  } else {
    lines.push('Only test data: listed companies with seeded users.');
  }
  return lines;
}

/** Pure. `destroyData` is undefined without the flag, and '' when it has no value. */
export function decideRollback({ verdict, project, yes, destroyData, interactive }) {
  if (destroyData !== undefined && destroyData !== project) {
    return {
      action: 'refuse',
      message: `--destroy-data must be followed by the project name, typed exactly: ${project}`,
    };
  }
  if (destroyData === project) return { action: 'proceed' };
  if (verdict === 'real') {
    if (interactive) return { action: 'confirm-typed' };
    return {
      action: 'refuse',
      message: `Refusing: real data may exist${yes ? ', and --yes alone is not enough' : ''}. Nothing was deleted. To go ahead anyway: pnpm dev:rollback --destroy-data ${project}`,
    };
  }
  return yes ? { action: 'proceed' } : { action: 'confirm-yes' };
}

/** Accepts `--destroy-data katip` and `--destroy-data=katip`. A missing value is ''. */
export function destroyDataFlag(argv) {
  const joined = argv.find((a) => a.startsWith('--destroy-data='));
  if (joined) return joined.slice('--destroy-data='.length);
  const at = argv.indexOf('--destroy-data');
  if (at === -1) return undefined;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? '' : value;
}

const GOVERNANCE_TENANTS_SQL = `select coalesce(json_agg(json_build_object('slug', t.slug, 'status', t.status, 'users',
  (select coalesce(json_agg(json_build_object('email', u.email, 'status', u.status)), '[]'::json)
   from users u where u.tenant_id = t.id))), '[]'::json) from tenants t`;

/** One line of JSON. Goes through mongosh in the container, so its password stays there. */
export const MONGO_INVENTORY_JS = `print(JSON.stringify(
  db.adminCommand({ listDatabases: 1, nameOnly: true }).databases
    .map((d) => d.name)
    .filter((name) => name.startsWith('lc_'))
    .map((name) => {
      const d = db.getSiblingDB(name);
      return {
        db: name,
        users: d.users.find({}, { email: 1 }).toArray().map((u) => ({ id: String(u._id), email: u.email })),
        chats: d.conversations.countDocuments(),
        chatOwners: d.conversations.distinct('user').map(String),
      };
    }),
));`;

/** Commands against the two databases. The containers hold their own credentials. */
export const psqlArgs = ({ pg }, sql, database = 'governance') => [
  'exec',
  '-e',
  `K_SQL=${sql}`,
  '-e',
  `K_DB=${database}`,
  pg,
  'sh',
  '-c',
  'psql -U "$POSTGRES_USER" -d "$K_DB" -v ON_ERROR_STOP=1 -Atc "$K_SQL"',
];

export const mongoshArgs = ({ mongo }, code) => [
  'exec',
  '-e',
  `K_CODE=${code}`,
  mongo,
  'sh',
  '-c',
  'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin admin --eval "$K_CODE"',
];

const lastLine = (s) => s.trim().split('\n').at(-1) ?? '';

/** Reads the install with what's already running: nothing is started. */
export async function readSnapshot(docker, project, containers, hostSlugs) {
  const snapshot = { volumes: null, governance: null, mongo: null, hostSlugs, problems: [] };
  const attempt = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const vols = await attempt(() => docker(['volume', 'ls', '--format', '{{.Name}}']));
  if (vols?.code === 0) {
    snapshot.volumes = vols.out
      .split('\n')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${project}_`) || v.startsWith(`${project}-`));
  }
  // A database from before the first migration has no companies in it.
  const hasSchema = await attempt(() =>
    docker(psqlArgs(containers, "select to_regclass('public.tenants') is not null")),
  );
  if (hasSchema?.code === 0 && lastLine(hasSchema.out) === 'f') {
    snapshot.governance = [];
  } else if (hasSchema?.code === 0) {
    const rows = await attempt(() => docker(psqlArgs(containers, GOVERNANCE_TENANTS_SQL)));
    if (rows?.code === 0) {
      snapshot.governance = await attempt(() => JSON.parse(lastLine(rows.out)));
    }
  }
  const inventory = await attempt(() => docker(mongoshArgs(containers, MONGO_INVENTORY_JS)));
  if (inventory?.code === 0) {
    snapshot.mongo = await attempt(() => JSON.parse(lastLine(inventory.out)));
  }
  return snapshot;
}

/** What's still on this host after a teardown. `docker` must not throw on a failed command. */
export async function leftovers(docker, project) {
  const names = async (args) => {
    const { code, out } = await docker(args);
    if (code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed`);
    return out
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);
  };
  const found = [];
  const mine = (n) => n.startsWith(`${project}_`) || n.startsWith(`${project}-`);
  for (const [kind, args] of [
    ['container', ['ps', '-a', '--format', '{{.Names}}']],
    ['volume', ['volume', 'ls', '--format', '{{.Name}}']],
    ['network', ['network', 'ls', '--format', '{{.Name}}']],
  ]) {
    for (const name of (await names(args)).filter(mine))
      found.push(`${kind} ${name} is still there`);
  }
  return found;
}

const firstFailure = (e) => e.message.trim().split('\n').at(-1);

/**
 * Runs every step's teardown, last step first, and returns what failed. The config step goes
 * last, as it deletes the secrets and rendered files, and only if everything else has gone:
 * without them a re-run couldn't finish, and whatever is left couldn't be opened.
 */
export async function teardown(allSteps, ctx, findLeftovers) {
  const failures = [];
  for (const step of [...allSteps].reverse()) {
    if (typeof step.rollback !== 'function') continue;
    if (step.id === 'config') {
      try {
        failures.push(...(await findLeftovers()));
      } catch (e) {
        failures.push(`could not check what is left: ${firstFailure(e)}`);
      }
      if (failures.length > 0) {
        failures.push('kept the rendered files and company secrets, so a re-run can finish');
        continue;
      }
    }
    try {
      await step.rollback(ctx);
    } catch (e) {
      failures.push(`${step.id}: ${firstFailure(e)}`);
    }
  }
  return failures;
}

/**
 * The whole safe rollback, for `pnpm dev:rollback` and for `r` at dev:up's Ctrl+C prompt. Returns
 * done, aborted (the person said no), refused or failed. Only done means it's all gone.
 */
export async function runRollback({ project, options, deps }) {
  const { yes = false, destroyData, interactive = false } = options;
  const assessment = assessData(await deps.readSnapshot(), deps.config);
  for (const line of describeData(assessment, project)) deps.print(line);
  const decision = decideRollback({
    verdict: assessment.verdict,
    project,
    yes,
    destroyData,
    interactive,
  });
  if (decision.action === 'refuse') {
    deps.printError(decision.message);
    return 'refused';
  }
  if (decision.action === 'confirm-typed') {
    const answer = await deps.ask(
      `This cannot be undone. Type the project name (${project}) to delete all of it: `,
    );
    if (answer !== project) {
      deps.print('aborted: nothing was deleted.');
      return 'aborted';
    }
  } else if (decision.action === 'confirm-yes') {
    const answer = await deps.ask('Delete all of this? [y/N] ');
    if (answer === null) {
      deps.printError('Refusing: no answer on standard input. Nothing was deleted. Use --yes.');
      return 'refused';
    }
    if (!['y', 'yes'].includes(answer.toLowerCase())) {
      deps.print('aborted: nothing was deleted.');
      return 'aborted';
    }
  }
  const failures = await deps.teardown();
  if (failures.length > 0) {
    deps.printError('rollback did NOT finish:');
    for (const f of failures) deps.printError(`  - ${f}`);
    return 'failed';
  }
  return 'done';
}
