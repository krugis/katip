// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:console: each role in a real browser, on the running dev stack (tracker P1-25).
 * It also follows a real invite email, from Mailpit, through to LibreChat. The tenant is
 * purged afterwards. Screenshots land in apps/console/e2e/artifacts.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { adminClient, findUser, totp } from '../../../scripts/setup/kc-lib.mjs';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ARTIFACTS = join(import.meta.dirname, 'artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

// The browser resolves *.localhost by itself; Node needs to be told.
const originalLookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options;
  if (!host.endsWith('.localhost')) return originalLookup(host, opts, cb);
  if (opts.all) return cb(null, [{ address: '127.0.0.1', family: 4 }]);
  return cb(null, '127.0.0.1', 4);
};

const env = Object.fromEntries(
  readFileSync(join(ROOT, 'infra/env/katip.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_0-9]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\s+#.*$/, '')]),
);
const config = readFileSync(join(ROOT, 'katip.config.yaml'), 'utf8');
const base = /base_domain:\s*(\S+)/.exec(config)[1];
const realm = /realm:\s*(\S+)/.exec(config)[1];
const project = /\n\s*name:\s*(\S+)/.exec(config)[1];
const authUrl = `https://auth.${base}`;
const consoleUrl = `https://console.${base}`;

const slug = `e2e-${randomBytes(3).toString('hex')}`;
const domain = `${slug}.test`;
const password = 'e2e-Password-1';
const secrets = new Map();

let checks = 0;
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
  console.log(`  ok  ${what}`);
};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
const cli = (...args) => sh('node', ['scripts/setup/tenant-cli.mjs', ...args]);
const sql = (query) =>
  sh('docker', [
    'exec',
    `${project}-postgres-1`,
    'psql',
    '-U',
    env.POSTGRES_USER,
    '-d',
    'governance',
    '-Atc',
    query,
  ]).trim();
const mailpit = (path) =>
  JSON.parse(
    sh('docker', ['exec', `${project}-mailpit-1`, 'wget', '-qO-', `http://localhost:8025${path}`]),
  );

const onAuth = (page) => new URL(page.url()).host === `auth.${base}`;
const clickSubmit = (page) =>
  page.locator('input[type=submit], button[type=submit]').first().click();

/** Keycloak takes each code once, so this waits for one that hasn't been used. */
const usedSteps = new Map();
async function freshCode(email) {
  const stepOf = (t) => Math.floor(t / 30_000);
  while (stepOf(Date.now()) <= (usedSteps.get(email) ?? -1)) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  usedSteps.set(email, stepOf(Date.now()));
  return totp(secrets.get(email));
}

/** Completes the MFA enrolment or code page, if that's where we are. */
async function mfaStep(page, email) {
  if (await page.locator('input[name=totpSecret]').count()) {
    const secret = await page.locator('input[name=totpSecret]').inputValue();
    secrets.set(email, secret);
    await page.locator('input[name=totp]').fill(await freshCode(email));
    await page.locator('input[name=userLabel]').fill('e2e');
    await clickSubmit(page);
    return true;
  }
  if (await page.locator('input[name=otp]').count()) {
    await page.locator('input[name=otp]').fill(await freshCode(email));
    await clickSubmit(page);
    return true;
  }
  return false;
}

/** Signs in at Keycloak, from wherever the app sent us. */
async function signIn(page, email, leaveHost) {
  await page.waitForURL((u) => u.host === `auth.${base}`);
  await page.locator('input[name=username]').fill(email);
  await clickSubmit(page);
  await page.locator('input[name=password]').fill(password);
  await clickSubmit(page);
  // Either Keycloak asks about MFA, or we're through.
  const mfa = page.locator('input[name=totpSecret], input[name=otp]').first();
  const left = page.waitForURL((u) => u.host === leaveHost);
  // Attached, not visible: the enrolment page's secret is a hidden field.
  await Promise.race([mfa.waitFor({ state: 'attached' }), left]);
  if (onAuth(page)) await mfaStep(page, email);
  await left;
}

async function openConsole(browser, email, cspErrors) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'tr-TR' });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text());
  });
  await page.goto(consoleUrl);
  await signIn(page, email, `console.${base}`);
  await page.getByTestId('sign-out').waitFor();
  return { context, page };
}

const visibleAreas = async (page) =>
  (
    await Promise.all(
      ['provider', 'tenant', 'department', 'account'].map(async (a) =>
        (await page.getByTestId(`area-${a}`).count()) ? a : null,
      ),
    )
  ).filter(Boolean);
const shot = (page, name) =>
  page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true });
const tokenOf = (page) =>
  page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('oidc.user:'));
    return JSON.parse(sessionStorage.getItem(key)).access_token;
  });

console.log(`Console on tenant ${slug}`);
const browser = await chromium.launch();
const cspErrors = [];
let providerEmail = null;
let created = false;
// A new login each call: this test outlasts Keycloak's short admin tokens.
const api = async (...args) =>
  (await adminClient(authUrl, env.KC_BOOTSTRAP_ADMIN_USER, env.KC_BOOTSTRAP_ADMIN_PASSWORD))(
    ...args,
  );
const R = `/realms/${realm}`;
const readyToLogIn = async (email) => {
  const u = await findUser(api, realm, email);
  await api('PUT', `${R}/users/${u.id}/reset-password`, {
    type: 'password',
    value: password,
    temporary: false,
  });
  await api('PUT', `${R}/users/${u.id}`, { requiredActions: ['CONFIGURE_TOTP'] });
};

try {
  cli(
    'create',
    '--slug',
    slug,
    '--name',
    'E2E Konsol A.Ş.',
    '--plan',
    'business',
    '--seats',
    '5',
    '--admin-email',
    `it@${domain}`,
  );
  created = true;
  const owner = `it@${domain}`;

  console.log('the real invite email');
  const found = mailpit(`/api/v1/search?query=to:${owner}`);
  check(found.messages_count === 1, 'the tenant admin got one invite');
  const mail = mailpit(`/api/v1/message/${found.messages[0].ID}`);
  const link = /https:\/\/auth\.[^\s"<]+action-token[^\s"<]+/.exec(mail.Text)?.[0];
  check(link, 'it holds a link');

  const inviteContext = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'tr-TR' });
  const invite = await inviteContext.newPage();
  await invite.goto(link.replaceAll('&amp;', '&'));
  for (let i = 0; i < 8 && onAuth(invite); i += 1) {
    await invite.waitForLoadState('domcontentloaded');
    if (await invite.locator('input[name=password-new]').count()) {
      await invite.locator('input[name=password-new]').fill(password);
      await invite.locator('input[name=password-confirm]').fill(password);
      await clickSubmit(invite);
    } else if (!(await mfaStep(invite, owner))) {
      const proceed = invite.locator('a[href*="action-token"], #kc-info-message a').first();
      if (!(await proceed.count())) break;
      await proceed.click();
    }
    await invite.waitForTimeout(500);
  }
  check(secrets.has(owner), 'following it sets a password and enrols MFA');
  await shot(invite, 'invite-finished');
  // Keycloak then asks them to sign in, with what they just set.
  await signIn(invite, owner, `${slug}.${base}`);
  await invite.waitForURL((u) => !u.pathname.startsWith('/oauth'), { timeout: 30_000 });
  await invite.waitForLoadState('networkidle').catch(() => undefined);
  await shot(invite, 'invite-librechat');
  const landed = new URL(invite.url());
  check(
    !landed.pathname.startsWith('/login'),
    `the invited admin is signed in to LibreChat (${landed.pathname})`,
  );
  await inviteContext.close();

  console.log('tenant admin');
  const { context: adminContext, page: admin } = await openConsole(browser, owner, cspErrors);
  check(
    (await visibleAreas(admin)).join() === 'tenant,account',
    'sees the company and their account',
  );
  check(new URL(admin.url()).pathname === '/tenant/overview', 'starts on the overview');
  check(
    (await admin.getByTestId('nav-tenant-users').textContent()) === 'Kullanıcılar',
    'in Turkish first',
  );
  check((await admin.locator('html').getAttribute('lang')) === 'tr', 'and says so to the browser');
  check(
    (await admin.getByTestId('open-chat').getAttribute('href')) === `https://${slug}.${base}`,
    "the chat link is the company's own",
  );
  await shot(admin, 'tenant-admin-tr');
  await admin.getByTestId('language').selectOption('en');
  check(
    (await admin.getByTestId('nav-tenant-users').textContent()) === 'Users',
    'switches to English',
  );
  await admin.reload();
  await admin.getByTestId('nav-tenant-users').waitFor();
  check(
    (await admin.getByTestId('nav-tenant-users').textContent()) === 'Users',
    'and keeps it on reload',
  );
  check(await admin.getByTestId('sign-out').isVisible(), 'a reload keeps them signed in');
  await shot(admin, 'tenant-admin-en');
  await admin.getByTestId('language').selectOption('tr');
  await admin.getByTestId('nav-tenant-users').click();
  await admin.getByTestId('coming-soon').waitFor();
  check(new URL(admin.url()).pathname === '/tenant/users', 'can move between screens');
  for (const path of ['/provider/tenants', '/department/overview']) {
    await admin.goto(`${consoleUrl}${path}`);
    await admin.getByTestId('no-access').waitFor();
    check(true, `going straight to ${path} says no access`);
  }
  await admin.goto(`${consoleUrl}/tenant/usage`);
  await admin.getByTestId('coming-soon').waitFor();
  check(new URL(admin.url()).pathname === '/tenant/usage', 'a deep link survives the redirects');

  const token = await tokenOf(admin);
  const tid = sql(`select id from tenants where slug = '${slug}'`);
  const invited = async (email, role) => {
    const res = await fetch(`${consoleUrl}/api/v1/tenants/${tid}/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'E2E Kişi', role }),
    });
    if (res.status !== 201) throw new Error(`invite ${email}: HTTP ${res.status}`);
    await readyToLogIn(email);
    return (await res.json()).id;
  };

  console.log('department manager');
  const managerEmail = `manager@${domain}`;
  await invited(managerEmail, 'dept_manager');
  const { context: managerContext, page: manager } = await openConsole(
    browser,
    managerEmail,
    cspErrors,
  );
  check(
    (await visibleAreas(manager)).join() === 'department,account',
    'sees their department and account',
  );
  await manager.goto(`${consoleUrl}/tenant/users`);
  await manager.getByTestId('no-access').waitFor();
  check(true, 'not the company screens');
  await shot(manager, 'department-manager-no-access');
  await managerContext.close();

  console.log('user');
  const userEmail = `user@${domain}`;
  const userId = await invited(userEmail, 'user');
  const { context: userContext, page: person } = await openConsole(browser, userEmail, cspErrors);
  check((await visibleAreas(person)).join() === 'account', 'sees only their account');
  check(new URL(person.url()).pathname === '/account/usage', 'starts on their usage');
  await shot(person, 'user');
  for (const path of ['/tenant/users', '/department/overview', '/provider/tenants']) {
    await person.goto(`${consoleUrl}${path}`);
    await person.getByTestId('no-access').waitFor();
  }
  check(true, 'going straight to other areas says no access');

  console.log('a disabled user');
  const off = await fetch(`${consoleUrl}/api/v1/tenants/${tid}/users/${userId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'disabled' }),
  });
  check(off.status === 200, 'the admin disables them');
  await person.goto(`${consoleUrl}/account/usage`);
  await person.getByTestId('problem-code').waitFor();
  check(
    (await person.getByTestId('problem-code').getAttribute('data-code')) === 'user_disabled',
    'their open console says the account is disabled',
  );
  check((await person.getByTestId('nav-account-usage').count()) === 0, 'and shows no menu');
  check(await person.getByTestId('problem-sign-out').isVisible(), 'and lets them sign out');
  await shot(person, 'user-disabled');
  await userContext.close();

  console.log('provider admin');
  providerEmail = `staff-${slug}@katip.test`;
  await api('POST', `${R}/users`, {
    username: providerEmail,
    email: providerEmail,
    firstName: 'E2E',
    lastName: 'Staff',
    enabled: true,
    emailVerified: true,
    requiredActions: ['CONFIGURE_TOTP'],
    credentials: [{ type: 'password', value: password, temporary: false }],
  });
  const staff = await findUser(api, realm, providerEmail);
  const role = await api('GET', `${R}/roles/provider_admin`);
  await api('POST', `${R}/users/${staff.id}/role-mappings/realm`, [role]);
  const providerOrg = (await api('GET', `${R}/organizations?max=1000`)).find(
    (o) => o.alias === 'provider',
  );
  await api('POST', `${R}/organizations/${providerOrg.id}/members`, staff.id);
  const { context: providerContext, page: provider } = await openConsole(
    browser,
    providerEmail,
    cspErrors,
  );
  check((await visibleAreas(provider)).join() === 'provider', 'sees only the provider area');
  await provider.getByTestId('tenants').waitFor();
  check(
    (await provider.getByTestId('tenants').textContent()).includes(slug),
    'the company list comes from the real API',
  );
  check((await provider.getByTestId('open-chat').count()) === 0, 'has no chat link');
  await shot(provider, 'provider');
  await providerContext.close();

  console.log('sign out');
  await admin.goto(consoleUrl);
  await admin.getByTestId('sign-out').click();
  await admin
    .waitForURL((u) => u.host === `auth.${base}`, { timeout: 30_000 })
    .catch(() => undefined);
  await admin.waitForLoadState('domcontentloaded');
  const confirm = admin.locator('input[type=submit]#kc-logout, button#kc-logout');
  if (await confirm.count()) await confirm.click();
  await admin.waitForTimeout(1500);
  await admin.goto(consoleUrl);
  await admin.waitForURL((u) => u.host === `auth.${base}`, { timeout: 30_000 });
  check(
    await admin.locator('input[name=username]').isVisible(),
    'signing out really ends the session',
  );
  await adminContext.close();

  console.log('the page itself');
  const headers = (await fetch(consoleUrl)).headers;
  const csp = headers.get('content-security-policy') ?? '';
  check(
    /script-src 'self'/.test(csp) && !csp.includes('unsafe'),
    'it has a strict content security policy',
  );
  check(/frame-ancestors 'none'/.test(csp), 'and cannot be framed');
  check(
    cspErrors.length === 0,
    `no page broke that policy${cspErrors[0] ? `: ${cspErrors[0]}` : ''}`,
  );
  const deep = (await fetch(`${consoleUrl}/tenant/users`)).headers.get('content-security-policy');
  check(deep === csp, 'on every route');
  const unauthenticated = await fetch(`${consoleUrl}/api/v1/me`);
  check(unauthenticated.status === 401, 'the API still answers on the same address');
  console.log(`\nAll ${checks} checks passed. Screenshots: apps/console/e2e/artifacts`);
} catch (e) {
  console.error(`\n${e.stack ?? e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (providerEmail) {
    const staff = await findUser(api, realm, providerEmail).catch(() => null);
    if (staff) await api('DELETE', `${R}/users/${staff.id}`).catch(() => undefined);
  }
  // E2E_KEEP=1 leaves the tenant, to look into a failure.
  if (created && !process.env.E2E_KEEP) {
    try {
      cli('delete', '--slug', slug, '--confirm', slug);
      sql(
        `update jobs set payload = jsonb_set(payload, '{purgeAfter}', '"2000-01-01T00:00:00.000Z"') where type = 'tenant.purge' and status = 'pending' and payload->>'slug' = '${slug}'`,
      );
      cli('purge-due');
    } catch (e) {
      console.error(`could not clean up ${slug}: ${e.message.slice(0, 200)}`);
    }
  }
}
