// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end login check (P1-19, LLD-02 §8) through Traefik, as a browser would:
//   1. a new local user is forced to enrol MFA, then reaches LibreChat
//   2. the next login asks for the code instead of enrolling again
//   3. a user who is a member of another tenant is refused
//   4. the logged-in user can chat through LibreChat and the gateway
// Uses users with a random password. The member stays in Keycloak, disabled between
// runs: LibreChat refuses a login when a known email arrives with a new Keycloak id.
import { randomBytes, randomUUID } from 'node:crypto';
import { adminClient, findClient, findUser, grantClientRole, totp } from './kc-lib.mjs';

const { realm, baseDomain, tenant, client, smokeEmail, chatEndpoint, otherClientId } = JSON.parse(
  process.env.KATIP_IDENTITY,
);
const api = await adminClient(
  process.env.KC_URL,
  process.env.KC_ADMIN_USER,
  process.env.KC_ADMIN_PASSWORD,
);
const R = `/realms/${realm}`;
const lcUrl = `https://${tenant.slug}.${baseDomain}`;
const password = randomBytes(24).toString('base64url');
// LibreChat rejects API calls without a browser's user agent.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

/** Minimal browser: a cookie jar and manual redirects. */
function browser() {
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
function parseForm(html) {
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

const submit = (b, form, extra) =>
  b.go(form.action, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form.fields, ...extra }),
  });

async function makeUser(email) {
  await api('POST', `${R}/users`, {
    username: email,
    email,
    firstName: 'Smoke',
    lastName: 'Test',
    enabled: true,
    emailVerified: true,
    credentials: [{ type: 'password', value: password, temporary: false }],
  });
  return findUser(api, realm, email);
}

/** The member, ready for a first login: new password, no MFA yet, and it must enrol. */
async function prepareMember(email) {
  const existing = await findUser(api, realm, email);
  if (!existing) return makeUser(email);
  const U = `${R}/users/${existing.id}`;
  for (const c of await api('GET', `${U}/credentials`)) {
    if (c.type === 'otp') await api('DELETE', `${U}/credentials/${c.id}`);
  }
  await api('PUT', `${U}/reset-password`, { type: 'password', value: password, temporary: false });
  await api('PUT', U, { enabled: true, requiredActions: ['CONFIGURE_TOTP'] });
  return existing;
}

async function disableUser(email) {
  const u = await findUser(api, realm, email);
  if (u) await api('PUT', `${R}/users/${u.id}`, { enabled: false });
}

async function removeUser(email) {
  const u = await findUser(api, realm, email);
  if (u) await api('DELETE', `${R}/users/${u.id}`);
}

/**
 * Opens LibreChat's login and submits the credentials; returns the page after them.
 * With Organizations on, Keycloak asks for the email first and the password next.
 */
async function passwordStep(b, email) {
  const page = await b.go(`${lcUrl}/oauth/openid`);
  if (!page.url.includes(`/realms/${realm}/`)) {
    throw new Error(`login did not reach Keycloak: ${page.status} ${page.url}`);
  }
  if (!page.html.includes('login-resources') && !page.html.includes('katip')) {
    throw new Error('login page is not using the expected theme');
  }
  const next = await submit(b, parseForm(page.html), { username: email });
  if (!next.html.includes('name="password"')) {
    throw new Error('Keycloak did not ask for a password');
  }
  return submit(b, parseForm(next.html), { password });
}

/** Completes the TOTP enrolment page and returns the page after it. */
async function enrol(b, page) {
  const form = parseForm(page.html);
  // Past the end of the current step's code window is fine: Keycloak allows ±1 step.
  return submit(b, form, { totp: totp(form.fields.totpSecret), userLabel: 'smoke' });
}

/**
 * Sends one chat message the way LibreChat's client does, and returns the answer and
 * conversation id. Fails if the gateway refuses the user, so it proves the user header.
 */
async function chatThroughLibreChat(b) {
  const common = { 'user-agent': USER_AGENT };
  const refresh = await fetch(`${lcUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { ...common, cookie: b.cookieHeader(lcHost) },
  });
  if (!refresh.ok) throw new Error(`LibreChat session refresh failed: HTTP ${refresh.status}`);
  const { token } = await refresh.json();
  const auth = { ...common, authorization: `Bearer ${token}` };

  const started = await fetch(`${lcUrl}/api/agents/chat/${encodeURIComponent(chatEndpoint)}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'merhaba',
      sender: 'User',
      isCreatedByUser: true,
      messageId: randomUUID(),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId: null,
      endpoint: chatEndpoint,
      endpointType: 'custom',
      model: 'fast',
    }),
  });
  if (!started.ok) throw new Error(`LibreChat chat request failed: HTTP ${started.status}`);
  const { streamId, conversationId } = await started.json();

  const stream = await fetch(`${lcUrl}/api/agents/chat/stream/${encodeURIComponent(streamId)}`, {
    headers: auth,
    signal: AbortSignal.timeout(60_000),
  });
  const body = await stream.text();
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      continue;
    }
    if (!event.final) continue;
    const msg = event.responseMessage;
    const text = msg?.text || (msg?.content ?? []).map((p) => p.text ?? '').join('');
    return { text, conversationId, error: msg?.error === true };
  }
  throw new Error(`chat stream ended without an answer: ${body.slice(-300)}`);
}

const lcHost = new URL(lcUrl).host;
const member = smokeEmail;
const outsider = `smoke-outsider@${tenant.slug}.${baseDomain}`;

try {
  await removeUser(outsider);
  const lc = await findClient(api, realm, client.id);

  // 1. Forced enrolment, then into LibreChat.
  const m = await prepareMember(member);
  await grantClientRole(api, realm, lc, m.id, 'member');
  const b1 = browser();
  const afterPassword = await passwordStep(b1, member);
  if (!afterPassword.html.includes('name="totpSecret"')) {
    throw new Error('a new local user was not forced to enrol MFA');
  }
  const done = await enrol(b1, afterPassword);
  if (!done.url.startsWith(lcUrl) || !b1.hasCookie(lcHost, 'refreshToken')) {
    throw new Error(`login with MFA did not reach LibreChat: ${done.status} ${done.url}`);
  }

  // The answer proves the path: LibreChat → gateway (knows the user) → LiteLLM → mock.
  const chat = await chatThroughLibreChat(b1);
  if (chat.error || !chat.text.includes('Echo:')) {
    throw new Error(`chat through LibreChat failed: ${chat.text.slice(0, 200)}`);
  }
  // Read by the smoke step, which checks the gateway recorded this conversation.
  console.log(`chat-conversation=${chat.conversationId}`);

  // 2. The next login asks for the code, and doesn't enrol again.
  const again = await passwordStep(browser(), member);
  if (again.html.includes('name="totpSecret"') || !/name="otp"/.test(again.html)) {
    throw new Error('second login did not ask for the MFA code');
  }

  // 3. No `member` role: refused, even with correct password and MFA.
  // A member of another tenant, which is what must not get in.
  const o = await makeUser(outsider);
  if (otherClientId) {
    await grantClientRole(api, realm, await findClient(api, realm, otherClientId), o.id, 'member');
  }
  const b3 = browser();
  const refused = await enrol(b3, await passwordStep(b3, outsider));
  if (b3.hasCookie(lcHost, 'refreshToken')) {
    throw new Error(`a user without the member role logged in: ${refused.url}`);
  }
  // Refused by LibreChat, after Keycloak accepted the login: not a failed MFA step.
  if (!refused.url.startsWith(lcUrl)) {
    throw new Error(`the non-member login stopped before LibreChat: ${refused.url}`);
  }

  console.log('oidc smoke ok: MFA forced, login and chat work, non-member refused');
} finally {
  await disableUser(member).catch(() => {});
  await removeUser(outsider).catch(() => {});
}
