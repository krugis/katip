// SPDX-License-Identifier: AGPL-3.0-only
// Applies the realm from katip.config.yaml through the Keycloak Admin API
// (P1-19, LLD-02 §1). Idempotent: a re-run updates settings and never touches
// the password or MFA of an existing user. Only what the whole platform shares: each
// tenant's organization, client and users come from the provisioner. Input comes from
// platformIdentityInput in config.mjs; secrets come as separate env variables.
import { adminClient, findClient } from './kc-lib.mjs';

const { realm, locales, defaultLocale, baseDomain, consoleOrigin } = JSON.parse(
  process.env.KATIP_IDENTITY,
);
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
await ensureOrganization('provider', 'Kâtip');

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

// ---- the provisioner: can manage this realm, and no other ------------------------
const PROVISIONER_CLIENT = 'katip-provisioner';
const provisionerRep = {
  clientId: PROVISIONER_CLIENT,
  name: 'Kâtip provisioner',
  protocol: 'openid-connect',
  publicClient: false,
  secret: process.env.PROVISIONER_CLIENT_SECRET,
  serviceAccountsEnabled: true,
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
};
let provisioner = await findClient(api, realm, PROVISIONER_CLIENT);
if (provisioner) {
  await api('PUT', `${R}/clients/${provisioner.id}`, { ...provisioner, ...provisionerRep });
} else {
  await api('POST', `${R}/clients`, provisionerRep);
  provisioner = await findClient(api, realm, PROVISIONER_CLIENT);
}
const serviceUser = await api('GET', `${R}/clients/${provisioner.id}/service-account-user`);
const realmManagement = await findClient(api, realm, 'realm-management');
const realmAdmin = await api('GET', `${R}/clients/${realmManagement.id}/roles/realm-admin`);
await api('POST', `${R}/users/${serviceUser.id}/role-mappings/clients/${realmManagement.id}`, [
  realmAdmin,
]);

console.log(`realm ${realm} applied`);
