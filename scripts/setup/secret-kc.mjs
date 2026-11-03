// SPDX-License-Identifier: AGPL-3.0-only
// Changes or tries a secret in Keycloak. Runs in a container that can reach it, with everything
// in its environment. Prints result=valid or result=invalid for a check, and never a value.
import process from 'node:process';
import { adminClient, findClient, findUser } from './kc-lib.mjs';

const {
  KC_ACTION: action,
  KC_URL: url,
  KC_REALM: realm,
  KC_ADMIN_USER: adminUser,
  KC_ADMIN_PASSWORD: adminPassword,
  KC_CLIENT_ID: clientId,
  KC_EMAILS: emails,
  KC_VALUE: value,
} = process.env;

const admin = () => adminClient(url, adminUser, adminPassword, { timeoutMs: 30_000 });

/** Keycloak's answer at the token endpoint. Only a refused login counts as "invalid". */
async function tokenAnswer(tokenRealm, form) {
  const r = await fetch(`${url}/realms/${tokenRealm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  if (r.status >= 500) throw new Error(`keycloak answered HTTP ${r.status}`);
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, description: body.error_description };
}

const report = (valid) => console.log(`result=${valid ? 'valid' : 'invalid'}`);

const ACTIONS = {
  async 'set-client-secret'() {
    const api = await admin();
    const client = await findClient(api, realm, clientId);
    if (!client) throw new Error(`client ${clientId} is missing`);
    await api('PUT', `/realms/${realm}/clients/${client.id}`, { ...client, secret: value });
    console.log('done');
  },
  async 'check-client-secret'() {
    const { ok, description } = await tokenAnswer(realm, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: value,
    });
    // A login client has no service account, and is refused for that once its secret has passed.
    // Keycloak 26.8.1 gives a wrong secret the same status and error code, so only this text
    // tells them apart. If an upgrade rewords it, a rotation refuses rather than passes wrongly,
    // and pnpm test:secrets-real fails.
    report(ok || /not enabled to retrieve service account/.test(description ?? ''));
  },
  async 'set-admin-password'() {
    const api = await admin();
    const [found] = await api(
      'GET',
      `/realms/master/users?username=${encodeURIComponent(adminUser)}&exact=true`,
    );
    if (!found) throw new Error('the admin user is missing');
    await api('PUT', `/realms/master/users/${found.id}/reset-password`, {
      type: 'password',
      value,
      temporary: false,
    });
    console.log('done');
  },
  async 'check-admin-password'() {
    const { ok } = await tokenAnswer('master', {
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUser,
      password: value,
    });
    report(ok);
  },
  async 'set-user-passwords'() {
    const api = await admin();
    for (const email of JSON.parse(emails)) {
      const user = await findUser(api, realm, email);
      // A company made with tenant:create has no demo users.
      if (!user) continue;
      await api('PUT', `/realms/${realm}/users/${user.id}/reset-password`, {
        type: 'password',
        value,
        temporary: false,
      });
    }
    console.log('done');
  },
};

const fn = ACTIONS[action];
if (!fn) throw new Error(`unknown action: ${action}`);
await fn();
