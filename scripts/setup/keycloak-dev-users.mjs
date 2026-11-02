// SPDX-License-Identifier: AGPL-3.0-only
// Dev only: demo users with a known password, matching the governance DB seed. A real
// tenant's first user comes from the provisioner, by invitation.
import { adminClient, findClient, findUser, grantClientRole } from './kc-lib.mjs';

const { realm, tenant, client, users } = JSON.parse(process.env.KATIP_IDENTITY);
const api = await adminClient(
  process.env.KC_URL,
  process.env.KC_ADMIN_USER,
  process.env.KC_ADMIN_PASSWORD,
);
const R = `/realms/${realm}`;
const lc = await findClient(api, realm, client.id);
if (!lc) throw new Error(`client ${client.id} is missing: provision the tenant first`);
const orgs = await api('GET', `${R}/organizations?max=1000`);
const org = orgs.find((o) => o.alias === tenant.slug);
if (!org) throw new Error(`organization ${tenant.slug} is missing: provision the tenant first`);

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
console.log(`demo users ready for ${tenant.slug}`);
