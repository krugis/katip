// SPDX-License-Identifier: AGPL-3.0-only
// Runs on a tenant's network, started by users-e2e.mjs: real tokens, real console-api, real
// Keycloak, real gateway.
import { lookup } from 'node:dns/promises';
import { adminClient, browser, consoleLogin, findUser } from './kc-lib.mjs';

const { realm, consoleOrigin, tenant } = JSON.parse(process.env.KATIP_IDENTITY);
const { TENANT_ID, OTHER_TENANT_ID, TENANT_KEY, OTHER_EMAIL } = process.env;
const kcUrl = process.env.KC_URL;
const api = await adminClient(kcUrl, process.env.KC_ADMIN_USER, process.env.KC_ADMIN_PASSWORD);
const R = `/realms/${realm}`;
const password = 'e2e-Password-1';
const owner = `it@${tenant.slug}.test`;
const domain = `${tenant.slug}.test`;

let checks = 0;
const ok = (what) => {
  checks += 1;
  console.log(`  ok  ${what}`);
};
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  ok(what);
};

/** Gives an invited user a password, as following the invite link would. */
async function readyToLogIn(email) {
  const u = await findUser(api, realm, email);
  const U = `${R}/users/${u.id}`;
  // A fresh enrolment each time, so the same login steps work on every try.
  for (const c of await api('GET', `${U}/credentials`)) {
    if (c.type === 'otp') await api('DELETE', `${U}/credentials/${c.id}`);
  }
  await api('PUT', `${U}/reset-password`, { type: 'password', value: password, temporary: false });
  await api('PUT', U, { requiredActions: ['CONFIGURE_TOTP'] });
  return u;
}
const logIn = (email) => consoleLogin(browser(), { kcUrl, realm, consoleOrigin, email, password });

const call = (token, method, path, body, type = 'application/json') =>
  fetch(`${consoleOrigin}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': type }),
    },
    ...(body === undefined ? {} : { body: type === 'text/csv' ? body : JSON.stringify(body) }),
  });
const users = `/tenants/${TENANT_ID}/users`;
const gateway = async (email) =>
  (
    await fetch('http://policy-gateway:8080/v1/models', {
      headers: { authorization: `Bearer ${TENANT_KEY}`, 'x-user-email': email },
    })
  ).status;
const roleNames = async (id) =>
  (await api('GET', `${R}/users/${id}/role-mappings/realm`)).map((r) => r.name);

console.log('the tenant admin logs in');
await readyToLogIn(owner);
const adminToken = await logIn(owner);
const me = await (await call(adminToken, 'GET', '/me')).json();
check(me.tenant?.id === TENANT_ID && me.roles.includes('tenant_admin'), 'it has its real token');

console.log('invite');
let r = await call(adminToken, 'POST', users, { email: `Alice@${domain}`, name: 'Alice Ayşe' });
const alice = await r.json();
check(r.status === 201 && alice.invited === true, 'an invite succeeds and sends its email');
check(alice.email === `alice@${domain}`, 'the email is stored in lower case');
const kcAlice = await findUser(api, realm, alice.email);
check(kcAlice?.requiredActions?.includes('UPDATE_PASSWORD'), 'Keycloak has the login, to set up');
const aliceOrgs = await api('GET', `${R}/organizations/members/${kcAlice.id}/organizations`);
check(aliceOrgs.length === 1 && aliceOrgs[0].alias === tenant.slug, 'it is in this company only');
check((await roleNames(kcAlice.id)).includes('user'), 'it has the role asked for');
const lcClient = (await api('GET', `${R}/clients?clientId=lc-${tenant.slug}`))[0];
const clientRoles = await api(
  'GET',
  `${R}/users/${kcAlice.id}/role-mappings/clients/${lcClient.id}`,
);
check(
  clientRoles.some((c) => c.name === 'member'),
  "it may log in to the company's LibreChat",
);
check((await gateway(alice.email)) === 200, 'the gateway serves the new user at once');

r = await call(adminToken, 'POST', users, { email: alice.email, name: 'Again' });
check(r.status === 409, 'inviting the same user twice is refused');
r = await call(adminToken, 'POST', users, { email: OTHER_EMAIL, name: 'Other' });
check(
  r.status === 409 && (await r.json()).code === 'email_in_use',
  "another company's user is refused",
);
const others = await findUser(api, realm, OTHER_EMAIL);
const otherOrgs = await api('GET', `${R}/organizations/members/${others.id}/organizations`);
check(!otherOrgs.some((o) => o.alias === tenant.slug), 'and did not join this company');

r = await call(adminToken, 'GET', users);
const listed = (await r.json()).users.map((u) => u.email);
check(listed.includes(alice.email) && listed.includes(owner), 'the list shows them');

r = await call(adminToken, 'POST', `${users}/${alice.id}/invite`);
check(r.status === 200, 'the invite can be sent again');

console.log('import');
const csv = [
  'email;name;department;tier',
  `bob@${domain};Bob;;`,
  `${alice.email};Alice;;`,
  'nope;Bad;;',
  `carol@${domain};Carol;;`,
].join('\r\n');
r = await call(adminToken, 'POST', `${users}/import`, csv, 'text/csv');
check(r.status === 202, 'an import starts in the background');
const { id: importId } = await r.json();
let imported;
for (let i = 0; i < 60; i += 1) {
  imported = await (await call(adminToken, 'GET', `${users}/imports/${importId}`)).json();
  if (imported.status !== 'running') break;
  await new Promise((done) => setTimeout(done, 500));
}
check(imported.status === 'done' && imported.created === 1, 'a good row is invited');
check(imported.skipped === 1, 'an existing user is skipped');
const reasons = imported.failed.map((f) => f.reason).sort();
check(reasons.join() === 'invalid_row,no_seats', 'a bad row and the row past the seat limit fail');
const bob = (await (await call(adminToken, 'GET', users)).json()).users.find((u) =>
  u.email.startsWith('bob@'),
);
check(await findUser(api, realm, bob.email), 'the imported user is in Keycloak');

console.log('role');
await readyToLogIn(alice.email);
let aliceToken = await logIn(alice.email);
check((await call(aliceToken, 'GET', '/me')).status === 200, 'a real user logs in');
r = await call(aliceToken, 'POST', users, { email: `x@${domain}`, name: 'X' });
check(r.status === 403, 'a plain user cannot invite');
r = await call(aliceToken, 'GET', users);
check(r.status === 403, 'nor list users');
r = await call(adminToken, 'PATCH', `${users}/${alice.id}`, { role: 'dept_manager' });
check(r.status === 200, 'the role can be changed');
const newRoles = await roleNames(kcAlice.id);
check(
  newRoles.includes('dept_manager') && !newRoles.includes('user'),
  'in Keycloak too, replacing the old one',
);
await call(adminToken, 'PATCH', `${users}/${alice.id}`, { role: 'user' });

console.log('tenant isolation');
r = await call(adminToken, 'GET', `/tenants/${OTHER_TENANT_ID}/users`);
check(r.status === 404, "another company's users answer 404");
r = await call(adminToken, 'POST', `/tenants/${OTHER_TENANT_ID}/users`, {
  email: `x@${domain}`,
  name: 'X',
});
check(r.status === 404, 'and it cannot invite there');
const noRoute = await lookup('identity').then(
  () => false,
  () => true,
);
check(noRoute, "the identity service can't be reached from a tenant's network");

console.log('lock-out protection');
r = await call(adminToken, 'PATCH', `${users}/${me.user.id}`, { status: 'disabled' });
check(r.status === 400, 'you cannot disable yourself');
r = await call(adminToken, 'PATCH', `${users}/${me.user.id}`, { role: 'user' });
check(r.status === 400, 'nor change your own role');

console.log('disable');
const sessions = async () => (await api('GET', `${R}/users/${kcAlice.id}/sessions`)).length;
check((await sessions()) > 0, 'the user has a session');
check((await gateway(alice.email)) === 200, 'and the gateway serves them');
const started = Date.now();
r = await call(adminToken, 'PATCH', `${users}/${alice.id}`, { status: 'disabled' });
check(r.status === 200, 'the admin disables them');
const gatewayCode = await gateway(alice.email);
const consoleCode = (await call(aliceToken, 'GET', '/me')).status;
const blockedAfter = Date.now() - started;
check(gatewayCode === 403, 'the gateway refuses them');
check(consoleCode === 403, 'the console refuses their token');
check(blockedAfter < 5000, `within 5 s (it took ${blockedAfter} ms)`);
check((await sessions()) === 0, 'their sessions are ended');
const offKc = await api('GET', `${R}/users/${kcAlice.id}`);
check(offKc.enabled === false, 'Keycloak has them disabled');
// Credentials ready, so only being disabled can stop this. The same login works further down.
await readyToLogIn(alice.email);
const refusedLogin = await logIn(alice.email).then(
  () => null,
  (e) => e.message,
);
// Keycloak answers with an error page, which has no form to go on with.
check(/no form|no login code/.test(refusedLogin ?? ''), 'they cannot log in again');

console.log('seats');
r = await call(adminToken, 'POST', users, { email: `dave@${domain}`, name: 'Dave' });
check(r.status === 201, "a disabled user's seat is free");
const dave = await r.json();
r = await call(adminToken, 'PATCH', `${users}/${alice.id}`, { status: 'active' });
check(r.status === 409 && (await r.json()).code === 'no_seats', 're-enabling needs a free seat');
await call(adminToken, 'PATCH', `${users}/${dave.id}`, { status: 'disabled' });
r = await call(adminToken, 'PATCH', `${users}/${alice.id}`, { status: 'active' });
check(r.status === 200, 'and works once there is one');
check((await gateway(alice.email)) === 200, 'the gateway serves them again');
await readyToLogIn(alice.email);
aliceToken = await logIn(alice.email);
check((await call(aliceToken, 'GET', '/me')).status === 200, 'and they can log in again');

console.log(`\nAll ${checks} checks passed.`);
