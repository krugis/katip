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

/** Calls the real gateway from inside the backend network, as a company's LibreChat would. */
const gateway = (email, path, body) => {
  const key = readFileSync(join(ROOT, `infra/env/tenants/${slug}.secrets.env`), 'utf8')
    .split('\n')
    .find((l) => l.includes('_GATEWAY_KEY='))
    .split('=')
    .slice(1)
    .join('=');
  const script = `fetch('http://policy-gateway:8080/v1' + process.env.P, {
      method: process.env.B ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + process.env.K, 'x-user-email': process.env.E, 'content-type': 'application/json' },
      ...(process.env.B ? { body: process.env.B } : {}),
    }).then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.text() })))`;
  const out = sh('docker', [
    'exec',
    '-e',
    `K=${key}`,
    '-e',
    `E=${email}`,
    '-e',
    `P=${path}`,
    '-e',
    `B=${body ? JSON.stringify(body) : ''}`,
    `${project}-console-api-1`,
    'node',
    '-e',
    script,
  ]);
  return JSON.parse(out);
};
/** How long a condition takes to come true on the real gateway. */
const within = async (seconds, condition) => {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (condition()) return Math.round((Date.now() - started) / 1000);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

const withinAsync = async (seconds, condition) => {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    if (await condition()) return Math.round((Date.now() - started) / 1000);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

/** The link in the one invite this person should have. */
const inviteLink = (email) => {
  const found = mailpit(`/api/v1/search?query=to:${email}`);
  if (found.messages_count < 1) return null;
  const mail = mailpit(`/api/v1/message/${found.messages[0].ID}`);
  return /https:\/\/auth\.[^\s"<]+action-token[^\s"<]+/.exec(mail.Text)?.[0] ?? null;
};

/** As the invited person: sets a password, enrols MFA, signs in, and reaches LibreChat. */
async function followInvite(browser, email, link, screenshot) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'tr-TR' });
  const page = await context.newPage();
  await page.goto(link.replaceAll('&amp;', '&'));
  for (let i = 0; i < 8 && onAuth(page); i += 1) {
    await page.waitForLoadState('domcontentloaded');
    if (await page.locator('input[name=password-new]').count()) {
      await page.locator('input[name=password-new]').fill(password);
      await page.locator('input[name=password-confirm]').fill(password);
      await clickSubmit(page);
    } else if (!(await mfaStep(page, email))) {
      const proceed = page.locator('a[href*="action-token"], #kc-info-message a').first();
      if (!(await proceed.count())) break;
      await proceed.click();
    }
    await page.waitForTimeout(500);
  }
  check(secrets.has(email), `${email} sets a password and enrols MFA`);
  await page.goto(`https://${slug}.${base}/oauth/openid`);
  // Keycloak then asks them to sign in, with what they just set.
  await signIn(page, email, `${slug}.${base}`);
  await page.waitForURL((u) => !u.pathname.startsWith('/oauth'), { timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (screenshot) await shot(page, `${screenshot}-librechat`);
  const landed = new URL(page.url());
  check(
    !landed.pathname.startsWith('/login'),
    `${email} is signed in to LibreChat (${landed.pathname})`,
  );
  await context.close();
}

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
    '10',
    '--admin-email',
    `it@${domain}`,
  );
  created = true;
  const owner = `it@${domain}`;

  console.log('the real invite email');
  const link = inviteLink(owner);
  check(link, 'the tenant admin got an invite with a link');

  await followInvite(browser, owner, link, 'invite');

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
  await admin.getByTestId('users-table').waitFor();
  check(new URL(admin.url()).pathname === '/tenant/users', 'can move between screens');
  for (const path of ['/provider/tenants', '/nowhere']) {
    await admin.goto(`${consoleUrl}${path}`);
    await admin.getByTestId('no-access').waitFor();
    check(true, `going straight to ${path} says no access`);
  }
  await admin.goto(`${consoleUrl}/tenant/billing`);
  await admin.getByTestId('coming-soon').waitFor();
  check(new URL(admin.url()).pathname === '/tenant/billing', 'a deep link survives the redirects');

  console.log('departments');
  await admin.getByTestId('nav-tenant-departments').click();
  await admin.getByTestId('departments-empty').waitFor();
  check(true, 'an empty list says what to do');
  const departmentForm = admin.getByTestId('department-form');
  await departmentForm.locator('input[name=name]').fill('Satış');
  await departmentForm.locator('input[name=budget]').fill('250');
  await admin.getByTestId('department-create').click();
  await admin.getByTestId('department-Satış').waitFor();
  check(
    (await admin.getByTestId('department-Satış').textContent()).includes('250'),
    'a department is created, with its budget',
  );
  await departmentForm.locator('input[name=name]').fill('Satış');
  await admin.getByTestId('department-create').click();
  await admin.getByTestId('form-error').waitFor();
  check(
    (await admin.getByTestId('form-error').textContent()).includes('zaten'),
    'a taken name is refused, in Turkish',
  );

  console.log('invite 3 users through the screen');
  await admin.getByTestId('nav-tenant-users').click();
  await admin.getByTestId('open-invite').click();
  const started = Date.now();
  const form = admin.getByTestId('invite-form');
  const newPeople = [
    [`ayse@${domain}`, 'Ayşe Yılmaz', 'user'],
    [`mehmet@${domain}`, 'Mehmet Öz', 'dept_manager'],
    [`zeynep@${domain}`, 'Zeynep Kaya', 'user'],
  ];
  for (const [email, name, role] of newPeople) {
    await form.locator('input[name=email]').fill(email);
    await form.locator('input[name=name]').fill(name);
    await form.locator('select[name=role]').selectOption(role);
    await form.locator('select[name=departmentId]').selectOption({ label: 'Satış' });
    await admin.getByTestId('invite-submit').click();
    await admin.getByTestId(`user-${email}`).waitFor();
  }
  check(true, 'three invites appear in the table');
  await shot(admin, 'users');
  for (const [email] of newPeople) {
    const invitedLink = inviteLink(email);
    check(invitedLink, `${email} got an email`);
    await followInvite(browser, email, invitedLink);
  }
  const took = Math.round((Date.now() - started) / 1000);
  check(took < 120, `all three are in LibreChat within 2 minutes (it took ${took} s)`);

  console.log('changing users on the screen');
  const fits = (selector) =>
    admin.evaluate((sel) => {
      const box = document.querySelector(sel)?.parentElement;
      return Boolean(box) && box.scrollWidth <= box.clientWidth;
    }, selector);
  await admin.goto(`${consoleUrl}/tenant/users`);
  const ayse = admin.getByTestId(`user-ayse@${domain}`);
  await ayse.waitFor();
  check(
    (await ayse.getByTestId('department').locator('option:checked').textContent()) === 'Satış',
    'the department was kept',
  );
  check(await fits('[data-testid=users-table]'), 'the table fits a laptop screen');
  admin.once('dialog', (d) => void d.accept());
  await ayse.getByTestId('disable').click();
  await ayse.locator('[data-status=disabled]').waitFor();
  check(true, 'a user can be disabled, after confirming');
  await ayse.getByTestId('enable').click();
  await ayse.locator('[data-status=active]').waitFor();
  check(true, 'and enabled again');
  await ayse.getByTestId('role').selectOption('dept_manager');
  await admin.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith('/users'));
  check(
    sql(`select role from users where email = 'ayse@${domain}'`) === 'dept_manager',
    'a role change is saved',
  );
  await ayse.getByTestId('role').selectOption('user');
  await admin.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith('/users'));
  const self = admin.getByTestId(`user-${owner}`);
  check((await self.getByTestId('disable').count()) === 0, 'you cannot disable yourself');
  check(await self.getByTestId('role').isDisabled(), 'nor change your own role');

  console.log('import a CSV');
  await admin.getByTestId('open-import').click();
  await admin.getByTestId('import-file').setInputFiles({
    name: 'kisiler.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `email;name;department\r\ncan@${domain};Can Demir;Satış\r\nbad-address;Hatalı;\r\nyok@${domain};Yok;Olmayan\r\n`,
    ),
  });
  await admin.locator('[data-testid=import-result][data-status=done]').waitFor({ timeout: 60_000 });
  const importText = await admin.getByTestId('import-result').textContent();
  check(
    importText.includes('1 eklendi') && importText.includes('2 başarısız'),
    'it reports what happened',
  );
  await admin.getByTestId(`user-can@${domain}`).waitFor();
  check(true, 'the new person appears without a reload');
  await shot(admin, 'users-import');

  console.log('managers and the overview');
  await admin.getByTestId('nav-tenant-departments').click();
  const satis = admin.getByTestId('department-Satış');
  await satis.getByTestId('department-edit').click();
  await admin.getByTestId(`manager-mehmet@${domain}`).check();
  await admin.getByTestId('department-save').click();
  // The row comes back a moment before its fresh data does.
  await satis.getByTestId('department-managers').filter({ hasText: 'Mehmet' }).waitFor();
  check(true, 'a manager can be assigned');
  await shot(admin, 'departments');
  await admin.getByTestId('nav-tenant-overview').click();
  await admin.getByTestId('seats-business').waitFor();
  check(
    (await admin.getByTestId('seats-business').textContent()).includes('10'),
    'the overview shows real seats',
  );
  await admin.getByTestId('quota-standard').waitFor();
  check(!/\$|USD/.test(await admin.locator('main').textContent()), 'and no cost');
  await shot(admin, 'overview');

  console.log('policies, through to the real gateway');
  await admin.getByTestId('nav-tenant-policies').click();
  const policyForm = admin.getByTestId('policy-form');
  await policyForm.waitFor();
  check(await admin.getByTestId('residency').isDisabled(), 'residency waits for the KVKK add-on');
  check((await admin.getByTestId('alias-tr-local').count()) === 0, 'and so does the Turkish model');
  const models = () => gateway(owner, '/models').body;
  check(models().includes('"best"'), 'the gateway offers best at first');
  await admin.getByTestId('alias-best').uncheck();
  await admin.getByTestId('policy-save').click();
  await admin.getByTestId('policy-saved').waitFor();
  const offered = await within(30, () => !models().includes('"best"'));
  check(offered !== null, `turning it off reaches the gateway within 30 s (took ${offered} s)`);
  await admin.getByTestId('alias-best').check();
  await admin.getByTestId('policy-save').click();
  await admin.getByTestId('policy-saved').waitFor();

  const chat = () =>
    gateway(owner, '/chat/completions', {
      model: 'fast',
      messages: [{ role: 'user', content: 'Adresim ayse.yilmaz@ornek.com.tr' }],
      max_tokens: 16,
    });
  // The gateway restores masked values in the reply, so this can't show what the model saw.
  // gateway.test.ts checks that, with a stand-in provider.
  check(chat().status === 200, 'a message with an email address goes through while masking');
  await admin.getByTestId('pii-mode').selectOption('block');
  await admin.getByTestId('policy-save').click();
  await admin.getByTestId('policy-saved').waitFor();
  const blocked = await within(30, () => chat().status === 400);
  check(blocked !== null, `blocking personal data takes effect within 30 s (took ${blocked} s)`);
  check(chat().body.includes('pii_blocked'), 'and says why');
  await admin.getByTestId('pii-mode').selectOption('off');
  check(
    await admin.getByTestId('pii-off-warning').isVisible(),
    'turning protection off warns first',
  );
  admin.once('dialog', (d) => void d.dismiss());
  await admin.getByTestId('policy-save').click();
  check(
    !sql(
      `select policy->'pii'->>'mode' from tenant_policies p join tenants t on t.id = p.tenant_id where t.slug = '${slug}'`,
    ).includes('off'),
    'and dismissing the question saves nothing',
  );
  await admin.getByTestId('pii-mode').selectOption('mask');
  await admin.getByTestId('policy-save').click();
  await admin.getByTestId('policy-saved').waitFor();
  check((await within(30, () => chat().status === 200)) !== null, 'masking comes back');
  await shot(admin, 'policies');

  console.log('access rules, through to real Traefik');
  // In a real tab, which is what the rule has to stop, and which trusts the dev certificate.
  const probe = await adminContext.newPage();
  const chatStatus = async () =>
    (await probe.goto(`https://${slug}.${base}/health`))?.status() ?? 0;
  await admin.getByTestId('nav-tenant-access').click();
  await admin.getByTestId('access-form').waitFor();
  const myIp = (await admin.getByTestId('caller-ip').textContent()).trim();
  check(myIp.length > 0, `the screen shows the caller's address (${myIp})`);
  check((await admin.getByTestId('mfa-note').count()) === 1, 'MFA is shown as always on');
  check((await chatStatus()) === 200, 'chat is open at first');
  await admin.getByTestId('ip-allowlist').fill('not an address');
  await admin.getByTestId('access-save').click();
  await admin.getByTestId('form-error').waitFor();
  check(true, 'a bad address is refused');
  const outside = '203.0.113.0/24';
  await admin.getByTestId('ip-allowlist').fill(outside);
  admin.once('dialog', (d) => void d.dismiss());
  await admin.getByTestId('access-save').click();
  await admin.waitForTimeout(1000);
  check(
    (await chatStatus()) === 200,
    'leaving out your own address asks first, and "no" keeps it open',
  );
  admin.once('dialog', (d) => void d.accept());
  await admin.getByTestId('access-save').click();
  await admin.getByTestId('access-saved').waitFor();
  const closed = await withinAsync(60, async () => (await chatStatus()) === 403);
  check(closed !== null, `an address not on the list is blocked within 60 s (took ${closed} s)`);
  check(await admin.getByTestId('access-form').isVisible(), 'the console still works, to undo it');
  await shot(admin, 'access-rules');
  const auditRow = sql(
    `select a.actor_type, a.details->>'ipRanges' from audit_log a join tenants t on t.id = a.tenant_id where t.slug = '${slug}' and a.action = 'access_rules.update' order by a.ts desc limit 1`,
  );
  check(auditRow === 'user|1', 'the audit log records who changed it');
  await admin.getByTestId('ip-allowlist').fill(myIp);
  await admin.getByTestId('access-save').click();
  await admin.getByTestId('access-saved').waitFor();
  const reopened = await withinAsync(60, async () => (await chatStatus()) === 200);
  check(reopened !== null, `an address on the list gets in within 60 s (took ${reopened} s)`);
  await admin.getByTestId('session-idle').fill('15');
  await admin.getByTestId('session-max').fill('8');
  await admin.getByTestId('ip-allowlist').fill('');
  await admin.getByTestId('access-save').click();
  await admin.getByTestId('access-saved').waitFor();
  const lcClient = (await api('GET', `${R}/clients?clientId=lc-${slug}`))[0];
  check(
    lcClient.attributes['client.session.idle.timeout'] === '900',
    'session limits reach Keycloak',
  );

  console.log('usage, from the real chats above');
  await admin.goto(`${consoleUrl}/tenant/usage`);
  await admin.getByTestId('usage-table').waitFor();
  const shownTotal = Number(await admin.getByTestId('usage-total').getAttribute('data-total'));
  const realTotal = Number(
    sql(
      `select sum(u.input_tokens + u.output_tokens) from usage_events u join tenants t on t.id = u.tenant_id where t.slug = '${slug}'`,
    ),
  );
  check(
    shownTotal > 0 && shownTotal === realTotal,
    `the total matches the events (${shownTotal} tokens)`,
  );
  check((await admin.getByTestId('usage-table').textContent()).includes(owner), 'by person');
  check(!/\$|USD|maliyet/i.test(await admin.locator('main').textContent()), 'and no cost');
  await shot(admin, 'usage');
  for (const group of ['model', 'dept', 'day']) {
    await admin.getByTestId('usage-group').selectOption(group);
    await admin.waitForResponse((r) => r.url().includes(`groupBy=${group}`));
    await admin.locator(`[data-testid=usage-total][data-total="${realTotal}"]`).waitFor();
  }
  check(true, 'every grouping adds up to the same total');
  const [csvFile] = await Promise.all([
    admin.waitForEvent('download'),
    admin.getByTestId('usage-export').click(),
  ]);
  check(/^usage-.*\.csv$/.test(csvFile.suggestedFilename()), 'a CSV downloads');
  await admin.getByTestId('usage-from').fill('2020-01-01');
  await admin.getByTestId('usage-to').fill('2020-01-31');
  await admin.getByTestId('usage-empty').waitFor();
  check(true, 'a range with nothing in it says so');
  await admin.getByTestId('usage-to').fill('2019-01-31');
  await admin.getByTestId('usage-error').waitFor();
  check(true, 'a backwards range says what is wrong');

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
  await manager.goto(`${consoleUrl}/department/overview`);
  await manager.getByTestId('no-department').waitFor();
  check(true, 'with no department yet, it says so');
  await managerContext.close();

  console.log('a manager with a department');
  const mehmetEmail = `mehmet@${domain}`;
  const ayseId = sql(`select id from users where email = 'ayse@${domain}'`);
  const tidForManager = sql(`select id from tenants where slug = '${slug}'`);
  const satisId = sql(
    `select id from departments where tenant_id = '${tidForManager}' and name = 'Satış'`,
  );
  const otherDept = await fetch(`${consoleUrl}/api/v1/tenants/${tidForManager}/departments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Başka' }),
  }).then((r) => r.json());
  gateway(`ayse@${domain}`, '/chat/completions', {
    model: 'fast',
    messages: [{ role: 'user', content: 'merhaba' }],
    max_tokens: 8,
  });
  sql(
    `insert into requests (tenant_id, user_id, type, payload) values ('${tidForManager}', '${ayseId}', 'premium_access', '{"reason":"Raporlar için"}'::jsonb)`,
  );
  const { context: mehmetContext, page: mehmet } = await openConsole(
    browser,
    mehmetEmail,
    cspErrors,
  );
  check(
    (await visibleAreas(mehmet)).join() === 'department,account',
    'sees their department and account',
  );
  await mehmet.getByTestId('department-summary').waitFor();
  check(
    (await mehmet.getByTestId('department-summary').textContent()).includes('Satış'),
    'starts on it',
  );
  await mehmet.getByTestId('nav-department-users').click();
  await mehmet.getByTestId('department-users').waitFor();
  check(
    (await mehmet.getByTestId('department-users').textContent()).includes(`ayse@${domain}`),
    'sees its people',
  );
  await mehmet.getByTestId('nav-department-usage').click();
  await mehmet.getByTestId('usage-table').waitFor();
  check(
    (await mehmet.getByTestId('usage-table').textContent()).includes(`ayse@${domain}`),
    'and its usage',
  );
  await shot(mehmet, 'department-usage');
  const mehmetToken = await tokenOf(mehmet);
  const otherStatus = (
    await fetch(`${consoleUrl}/api/v1/tenants/${tidForManager}/departments/${otherDept.id}/usage`, {
      headers: { authorization: `Bearer ${mehmetToken}` },
    })
  ).status;
  check(otherStatus === 404, 'another department answers 404');
  const satisStatus = (
    await fetch(`${consoleUrl}/api/v1/tenants/${tidForManager}/departments/${satisId}/usage`, {
      headers: { authorization: `Bearer ${mehmetToken}` },
    })
  ).status;
  check(satisStatus === 200, 'with the same token that reads their own');
  await mehmet.getByTestId('nav-department-requests').click();
  const request = mehmet.getByTestId(`request-ayse@${domain}`);
  await request.waitFor();
  check((await request.textContent()).includes('Raporlar için'), 'sees a request and its reason');
  await request.getByTestId('approve').click();
  await request.getByTestId('decision').waitFor();
  check(
    sql(`select status from requests where user_id = '${ayseId}'`) === 'approved',
    'and can approve it',
  );
  await shot(mehmet, 'department-requests');
  await mehmet.goto(`${consoleUrl}/tenant/users`);
  await mehmet.getByTestId('no-access').waitFor();
  check(true, 'but not the company screens');
  await mehmetContext.close();

  console.log('user');
  const userEmail = `user@${domain}`;
  const userId = await invited(userEmail, 'user');
  const { context: userContext, page: person } = await openConsole(browser, userEmail, cspErrors);
  check((await visibleAreas(person)).join() === 'account', 'sees only their account');
  check(new URL(person.url()).pathname === '/account/usage', 'starts on their usage');
  gateway(userEmail, '/chat/completions', {
    model: 'fast',
    messages: [{ role: 'user', content: 'merhaba' }],
    max_tokens: 8,
  });
  await person.reload();
  await person.getByTestId('usage-total').waitFor();
  const myTotal = Number(await person.getByTestId('usage-total').getAttribute('data-total'));
  const myReal = Number(
    sql(`select sum(input_tokens + output_tokens) from usage_events where user_id = '${userId}'`),
  );
  check(
    myTotal > 0 && myTotal === myReal,
    `a chat shows in their usage at once (${myTotal} tokens)`,
  );
  await person.getByTestId('nav-account-requests').click();
  await person.getByTestId('no-my-requests').waitFor();
  await person.getByTestId('request-type').selectOption('model');
  await person.getByTestId('request-reason').fill('Yeni model lazım');
  await person.getByTestId('request-send').click();
  await person.getByTestId('request-sent').waitFor();
  await person.getByTestId('my-requests').waitFor();
  check(true, 'they can ask for something, and see it');
  await shot(person, 'account-requests');
  await person.getByTestId('nav-account-sessions').click();
  check(
    (await person.getByTestId('keycloak-account').getAttribute('href')).endsWith(
      `/realms/${realm}/account`,
    ),
    'sessions and MFA link to their real account page',
  );
  await person.getByTestId('nav-account-privacy').click();
  const [exported] = await Promise.all([
    person.waitForEvent('download'),
    person.getByTestId('privacy-export').click(),
  ]);
  const exportPath = await exported.path();
  const exportedData = JSON.parse(readFileSync(exportPath, 'utf8'));
  check(exportedData.account.email === userEmail, 'they can download their data');
  check(exportedData.requests[0].reason === 'Yeni model lazım', 'with their requests');
  check(exportedData.chats.includes('LibreChat'), 'and it says where their chats are');
  person.once('dialog', (d) => void d.accept());
  await person.getByTestId('privacy-delete').click();
  await person.locator('[data-testid=my-privacy] [data-type=delete]').waitFor();
  check(true, 'they can ask for deletion');
  await shot(person, 'account-privacy');

  console.log('the admin answers');
  await admin.goto(`${consoleUrl}/tenant/requests`);
  const askedToDelete = admin.getByTestId(`privacy-${userEmail}-delete`);
  await askedToDelete.waitFor();
  check(
    (await sql(`select status from users where id = '${userId}'`)) === 'active',
    'asking deleted nothing',
  );
  await shot(admin, 'tenant-requests');
  await askedToDelete.getByTestId('privacy-complete').click();
  await admin
    .locator(`[data-testid="privacy-${userEmail}-delete"][data-status=completed]`)
    .waitFor();
  check(true, 'the admin sees the deletion request, and can mark it done');
  const theirRequest = admin.getByTestId(`tenant-request-${userEmail}`);
  await theirRequest.getByTestId('reject').click();
  await admin
    .locator(`[data-testid="tenant-request-${userEmail}"][data-status=rejected]`)
    .waitFor();
  check(true, 'and answer a request from someone with no department');
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

  console.log('the audit log');
  await admin.goto(`${consoleUrl}/tenant/audit`);
  await admin.getByTestId('audit-table').waitFor();
  const auditText = await admin.getByTestId('audit-table').textContent();
  check(auditText.includes('Kullanıcı davet edildi'), 'it shows what happened, in Turkish');
  check(auditText.includes(owner), 'and who did it');
  check(auditText.includes('Sistem'), 'and what the system did, such as creating the company');
  await admin.getByTestId('audit-action').selectOption('policy.update');
  await admin
    .locator('[data-testid=audit-table] tr[data-action=policy\\.update]')
    .first()
    .waitFor();
  check(
    (await admin
      .locator('[data-testid=audit-table] tbody tr:not([data-action=policy\\.update])')
      .count()) === 0,
    'it can be narrowed to one kind of event',
  );
  await shot(admin, 'audit');

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
  await provider.getByTestId('nav-provider-audit').click();
  await provider.getByTestId('audit-table').waitFor();
  check(
    (await provider.getByTestId('audit-table').textContent()).includes(slug),
    'sees the audit log across companies',
  );
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
