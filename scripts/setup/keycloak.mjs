// SPDX-License-Identifier: AGPL-3.0-only
// Applies the realm from katip.config.yaml through the Keycloak Admin API
// (P1-19, LLD-02 §1). Idempotent: a re-run updates settings and never touches
// the password or MFA of an existing user. Input comes from identityInput in
// config.mjs through KATIP_IDENTITY; secrets come as separate env variables.
import { adminClient, findClient, findUser, grantClientRole } from './kc-lib.mjs';

const { realm, locales, defaultLocale, baseDomain, consoleOrigin, tenant, client, users } =
  JSON.parse(process.env.KATIP_IDENTITY);
const api = await adminClient(
  process.env.KC_URL,
  process.env.KC_ADMIN_USER,
  process.env.KC_ADMIN_PASSWORD,
);
const R = `/realms/${realm}`;
const FLOW = `${realm}-browser`;

// ---- realm ------------------------------------------------------------------
if (!(await api('GET', R))) {
  await api('POST', '/realms', { realm, enabled: true, organizationsEnabled: true });
}
await api('PUT', R, {
  realm,
  enabled: true,
  organizationsEnabled: true,
  registrationAllowed: false,
  resetPasswordAllowed: true,
  loginWithEmailAllowed: true,
  duplicateEmailsAllowed: false,
  bruteForceProtected: true,
  loginTheme: 'katip',
  internationalizationEnabled: true,
  supportedLocales: locales,
  defaultLocale,
  // LLD-02 §1: access token 5 min, SSO idle 30 min, max 10 h
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 1800,
  ssoSessionMaxLifespan: 36000,
  webAuthnPolicyPasswordlessRpEntityName: 'Kâtip',
  attributes: { webAuthnPolicyPasswordlessPasskeysEnabled: 'true' },
  smtpServer: { host: 'mailpit', port: '1025', from: `noreply@${baseDomain}` },
});

// ---- realm roles ------------------------------------------------------------
const realmRoles = ['provider_admin', 'tenant_admin', 'dept_manager', 'user'];
for (const name of realmRoles) {
  if (!(await api('GET', `${R}/roles/${name}`))) await api('POST', `${R}/roles`, { name });
}

// ---- login flow: copy of the built-in browser flow with WebAuthn allowed -----
const flows = await api('GET', `${R}/authentication/flows`);
if (!flows.some((f) => f.alias === FLOW)) {
  await api('POST', `${R}/authentication/flows/browser/copy`, { newName: FLOW });
}
for (const e of await api('GET', `${R}/authentication/flows/${FLOW}/executions`)) {
  if (e.providerId === 'webauthn-authenticator' && e.requirement !== 'ALTERNATIVE') {
    await api('PUT', `${R}/authentication/flows/${FLOW}/executions`, {
      ...e,
      requirement: 'ALTERNATIVE',
    });
  }
}
await api('PUT', R, { realm, browserFlow: FLOW });

// ---- MFA: new local users must enrol at first login -------------------------
const totpAction = await api('GET', `${R}/authentication/required-actions/CONFIGURE_TOTP`);
await api('PUT', `${R}/authentication/required-actions/CONFIGURE_TOTP`, {
  ...totpAction,
  enabled: true,
  defaultAction: true,
});

// ---- organizations: one per tenant, plus our staff ---------------------------
async function ensureOrganization(alias, name) {
  // Keycloak's search matches name and domain, not alias, so list and filter.
  const find = async () =>
    (await api('GET', `${R}/organizations?max=1000`)).find((o) => o.alias === alias);
  const hit = await find();
  if (hit) return hit;
  await api('POST', `${R}/organizations`, {
    alias,
    name,
    enabled: true,
    domains: [{ name: `${alias}.${baseDomain}`, verified: false }],
  });
  return find();
}
const org = await ensureOrganization(tenant.slug, tenant.name);
await ensureOrganization('provider', 'Kâtip');

// ---- the tenant's LibreChat client, with the role that gates login -----------
const clientRep = {
  clientId: client.id,
  name: `LibreChat (${tenant.slug})`,
  protocol: 'openid-connect',
  publicClient: false,
  secret: process.env.LC_CLIENT_SECRET,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: false,
  redirectUris: [client.redirectUri],
  webOrigins: [client.origin],
  attributes: { 'post.logout.redirect.uris': `${client.origin}/*` },
};
let lc = await findClient(api, realm, client.id);
if (lc) {
  await api('PUT', `${R}/clients/${lc.id}`, { ...lc, ...clientRep });
} else {
  await api('POST', `${R}/clients`, clientRep);
  lc = await findClient(api, realm, client.id);
}
if (!(await api('GET', `${R}/clients/${lc.id}/roles/member`))) {
  await api('POST', `${R}/clients/${lc.id}/roles`, { name: 'member' });
}

// ---- the console: a browser app, so a public client with PKCE (LLD-02 §1) ------
const CONSOLE_CLIENT = 'console';
const consoleRep = {
  clientId: CONSOLE_CLIENT,
  name: 'Kâtip console',
  protocol: 'openid-connect',
  publicClient: true,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: false,
  redirectUris: [`${consoleOrigin}/*`],
  webOrigins: [consoleOrigin],
  attributes: {
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': `${consoleOrigin}/*`,
  },
};
let consoleClient = await findClient(api, realm, CONSOLE_CLIENT);
if (consoleClient) {
  await api('PUT', `${R}/clients/${consoleClient.id}`, { ...consoleClient, ...consoleRep });
} else {
  await api('POST', `${R}/clients`, consoleRep);
  consoleClient = await findClient(api, realm, CONSOLE_CLIENT);
}
// console-api only accepts tokens made for it.
const mappers = await api('GET', `${R}/clients/${consoleClient.id}/protocol-mappers/models`);
if (!mappers.some((m) => m.name === 'console-api-audience')) {
  await api('POST', `${R}/clients/${consoleClient.id}/protocol-mappers/models`, {
    name: 'console-api-audience',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: { 'included.custom.audience': 'console-api', 'access.token.claim': 'true' },
  });
}
// The tenant comes from the organization claim. Keycloak only adds it when the login asks
// for scope=organization, even as a default scope, so the console must request it.
const scopes = await api('GET', `${R}/client-scopes`);
const organizationScope = scopes.find((s) => s.name === 'organization');
if (!organizationScope) throw new Error('the organization client scope is missing');
await api('PUT', `${R}/clients/${consoleClient.id}/optional-client-scopes/${organizationScope.id}`);

// ---- demo users, matching the governance DB seed ----------------------------
for (const u of users) {
  let user = await findUser(api, realm, u.email);
  if (!user) {
    await api('POST', `${R}/users`, {
      username: u.email,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: ['CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: process.env.DEMO_USER_PASSWORD, temporary: false }],
    });
    user = await findUser(api, realm, u.email);
  }
  const role = await api('GET', `${R}/roles/${u.realmRole}`);
  await api('POST', `${R}/users/${user.id}/role-mappings/realm`, [role]);
  await grantClientRole(api, realm, lc, user.id, 'member');
  const members = await api('GET', `${R}/organizations/${org.id}/members?max=1000`);
  if (!members.some((m) => m.id === user.id)) {
    await api('POST', `${R}/organizations/${org.id}/members`, user.id);
  }
}

console.log(`realm ${realm} applied: client ${client.id}, ${users.length} users`);
