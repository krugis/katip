// SPDX-License-Identifier: AGPL-3.0-only
// Keycloak Admin API client and TOTP, for scripts that run on the edge network.
// No dependencies: these scripts run in any node image.
import { createHmac } from 'node:crypto';

/** RFC 6238 TOTP (HMAC-SHA1). `secret` is the raw secret, as Keycloak's setup form holds it. */
export function totp(secret, timeMs = Date.now(), digits = 6, stepSeconds = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / stepSeconds)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** Logs in to the master realm, retrying while Traefik and Keycloak come up. */
export async function adminClient(url, user, password, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let token = null;
  let last = '';
  while (!token && Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: user,
          password,
        }),
      });
      if (r.ok) token = (await r.json()).access_token;
      else last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code ?? e.message;
    }
    if (!token) await new Promise((res) => setTimeout(res, 3000));
  }
  if (!token) throw new Error(`keycloak admin login failed: ${last}`);

  /** Returns parsed JSON, or null for 404 and empty bodies. Other errors throw. */
  return async function api(method, path, body) {
    const r = await fetch(`${url}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) {
      // Keycloak's message only; request bodies can hold secrets.
      throw new Error(`keycloak ${method} ${path}: HTTP ${r.status} ${await r.text()}`);
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
}

export const findUser = async (api, realm, email) =>
  (await api('GET', `/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`))?.[0] ??
  null;

export const findClient = async (api, realm, clientId) =>
  (await api('GET', `/realms/${realm}/clients?clientId=${encodeURIComponent(clientId)}`))?.[0] ??
  null;

/** Grants a client role to a user. Granting it twice is harmless. */
export async function grantClientRole(api, realm, client, userId, roleName) {
  const role = await api('GET', `/realms/${realm}/clients/${client.id}/roles/${roleName}`);
  await api('POST', `/realms/${realm}/users/${userId}/role-mappings/clients/${client.id}`, [role]);
}
