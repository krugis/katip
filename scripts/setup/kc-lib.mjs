// SPDX-License-Identifier: AGPL-3.0-only
// Keycloak Admin API client and TOTP, for scripts that run on the edge network.
// No dependencies: these scripts run in any node image.
import { createHash, createHmac, randomBytes } from 'node:crypto';

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

// LibreChat rejects API calls without a browser's user agent.
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

/** Minimal browser: a cookie jar and manual redirects. */
export function browser() {
  const jar = new Map();
  async function go(url, init = {}) {
    let current = url;
    let opts = init;
    for (let hops = 0; hops < 12; hops++) {
      const host = new URL(current).host;
      const cookies = cookieHeader(host);
      const r = await fetch(current, {
        ...opts,
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          ...opts.headers,
          ...(cookies ? { cookie: cookies } : {}),
        },
      });
      for (const c of r.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(`${host}|${pair.slice(0, eq)}`, pair.slice(eq + 1));
      }
      const next = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && next) {
        current = new URL(next, current).href;
        opts = {};
        continue;
      }
      return { status: r.status, url: current, html: await r.text() };
    }
    throw new Error('too many redirects');
  }
  const cookieHeader = (host) =>
    [...jar.entries()]
      .filter(([k]) => k.startsWith(`${host}|`))
      .map(([k, v]) => `${k.split('|')[1]}=${v}`)
      .join('; ');
  return { go, cookieHeader, hasCookie: (host, name) => jar.has(`${host}|${name}`) };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x3D;/g, '=');

/** The page's form: action URL and hidden fields. */
export function parseForm(html) {
  const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>[\s\S]*?<\/form>/);
  if (!form) throw new Error('no form on the page');
  const fields = {};
  for (const tag of form[0].match(/<input[^>]*>/g) ?? []) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = tag.match(/name="([^"]+)"/)?.[1];
    if (name) fields[name] = decode(tag.match(/value="([^"]*)"/)?.[1] ?? '');
  }
  return { action: decode(form[1]), fields };
}

export const submit = (b, form, extra) =>
  b.go(form.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form.fields, ...extra }),
  });

/** Logs in to the console as a browser would, enrolling MFA if asked, and returns the token. */
export async function consoleLogin(b, { kcUrl, realm, consoleOrigin, email, password }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${consoleOrigin}/callback`;
  const authorize = new URL(`${kcUrl}/realms/${realm}/protocol/openid-connect/auth`);
  authorize.search = new URLSearchParams({
    client_id: 'console',
    response_type: 'code',
    scope: 'openid organization',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const first = await b.go(authorize.href);
  const passwordPage = await submit(b, parseForm(first.html), { username: email });
  let page = await submit(b, parseForm(passwordPage.html), { password });
  if (page.html.includes('name="totpSecret"')) {
    const form = parseForm(page.html);
    page = await submit(b, form, { totp: totp(form.fields.totpSecret), userLabel: 'e2e' });
  }
  const code = new URL(page.url).searchParams.get('code');
  if (!code) throw new Error(`no login code for ${email}: ${page.status}`);
  const tokenRes = await fetch(`${kcUrl}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'console',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
  return (await tokenRes.json()).access_token;
}
