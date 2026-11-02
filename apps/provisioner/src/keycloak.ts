// SPDX-License-Identifier: AGPL-3.0-only
// Keycloak Admin API for one realm, as a service account: not the master admin, which
// could reach every realm (LLD-02 §1).
import type { IdentityAdmin, TenantInput } from './provision.js';

export interface KeycloakOptions {
  url: string;
  realm: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/** The actions a new tenant admin must complete from the invite. */
const INVITE_ACTIONS = ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'];

const clientIdOf = (slug: string): string => `lc-${slug}`;
const originOf = (input: TenantInput): string => `https://${input.slug}.${input.baseDomain}`;

interface Named {
  id: string;
}

export class KeycloakAdmin implements IdentityAdmin {
  private readonly doFetch: typeof fetch;
  private token: string | null = null;

  constructor(private readonly opts: KeycloakOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const r = await this.doFetch(
      `${this.opts.url}/realms/${this.opts.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
        }),
      },
    );
    if (!r.ok) throw new Error(`keycloak login failed: HTTP ${r.status}`);
    this.token = ((await r.json()) as { access_token: string }).access_token;
    return this.token;
  }

  /** Parsed JSON; null for an empty body, and for a GET that finds nothing. */
  private async api<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const r = await this.doFetch(`${this.opts.url}/admin/realms/${this.opts.realm}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.login()}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status === 404 && method === 'GET') return null;
    if (!r.ok) throw new Error(`keycloak ${method} ${path.split('?')[0]}: HTTP ${r.status}`);
    const text = await r.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  private async organization(alias: string): Promise<(Named & { alias: string }) | null> {
    // Keycloak's search matches name and domain, not alias, so list and filter.
    const all = await this.api<(Named & { alias: string })[]>('GET', '/organizations?max=1000');
    return all?.find((o) => o.alias === alias) ?? null;
  }

  private async client(clientId: string): Promise<(Named & Record<string, unknown>) | null> {
    const found = await this.api<(Named & Record<string, unknown>)[]>(
      'GET',
      `/clients?clientId=${encodeURIComponent(clientId)}`,
    );
    return found?.[0] ?? null;
  }

  async ensureTenantIdentity(input: TenantInput, oidcClientSecret: string): Promise<boolean> {
    let changed = false;
    if (!(await this.organization(input.slug))) {
      await this.api('POST', '/organizations', {
        alias: input.slug,
        name: input.name,
        enabled: true,
        domains: [{ name: `${input.slug}.${input.baseDomain}`, verified: false }],
      });
      changed = true;
    }

    const origin = originOf(input);
    const rep = {
      clientId: clientIdOf(input.slug),
      name: `LibreChat (${input.slug})`,
      protocol: 'openid-connect',
      publicClient: false,
      secret: oidcClientSecret,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: [`${origin}/oauth/openid/callback`],
      webOrigins: [origin],
      attributes: { 'post.logout.redirect.uris': `${origin}/*` },
    };
    let client = await this.client(rep.clientId);
    if (client) {
      await this.api('PUT', `/clients/${client.id}`, { ...client, ...rep });
    } else {
      await this.api('POST', '/clients', rep);
      client = await this.client(rep.clientId);
      changed = true;
    }
    if (!client) throw new Error('the LibreChat client is missing after creating it');
    if (!(await this.api('GET', `/clients/${client.id}/roles/member`))) {
      await this.api('POST', `/clients/${client.id}/roles`, { name: 'member' });
      changed = true;
    }
    return changed;
  }

  async ensureAdmin(input: TenantInput): Promise<{ id: string }> {
    const find = async (): Promise<Named | null> =>
      (
        await this.api<Named[]>(
          'GET',
          `/users?email=${encodeURIComponent(input.adminEmail)}&exact=true`,
        )
      )?.[0] ?? null;
    let user = await find();
    if (user) {
      // One login belongs to one company: joining a second would cross the tenant boundary.
      const orgs = await this.api<{ alias: string }[]>(
        'GET',
        `/organizations/members/${user.id}/organizations`,
      );
      if (orgs?.some((o) => o.alias !== input.slug)) {
        throw new Error('this admin email already belongs to another company');
      }
    } else {
      await this.api('POST', '/users', {
        username: input.adminEmail,
        email: input.adminEmail,
        firstName: input.name,
        lastName: 'Admin',
        enabled: true,
        emailVerified: true,
        requiredActions: INVITE_ACTIONS,
      });
      user = await find();
    }
    if (!user) throw new Error('the tenant admin is missing after creating them');

    // Granting a role or membership twice is harmless, so a re-run can repeat these.
    const role = await this.api('GET', '/roles/tenant_admin');
    await this.api('POST', `/users/${user.id}/role-mappings/realm`, [role]);
    const client = await this.client(clientIdOf(input.slug));
    if (!client) throw new Error('the LibreChat client is missing');
    const member = await this.api('GET', `/clients/${client.id}/roles/member`);
    await this.api('POST', `/users/${user.id}/role-mappings/clients/${client.id}`, [member]);
    const org = await this.organization(input.slug);
    if (!org) throw new Error('the organization is missing');
    const members = await this.api<Named[]>('GET', `/organizations/${org.id}/members?max=1000`);
    if (!members?.some((m) => m.id === user.id)) {
      await this.api('POST', `/organizations/${org.id}/members`, user.id);
    }
    return { id: user.id };
  }

  async sendInvite(userId: string, input: TenantInput): Promise<void> {
    const query = new URLSearchParams({
      client_id: clientIdOf(input.slug),
      redirect_uri: `${originOf(input)}/oauth/openid/callback`,
    });
    await this.api('PUT', `/users/${userId}/execute-actions-email?${query}`, INVITE_ACTIONS);
  }
}
