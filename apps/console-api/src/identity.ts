// SPDX-License-Identifier: AGPL-3.0-only
// The internal identity service, which holds the Keycloak rights this API must not.
import { AppError, Errors } from '@katip/shared';

export type TenantRole = 'tenant_admin' | 'dept_manager' | 'user';

export interface IdentityClient {
  invite(
    slug: string,
    input: { email: string; name: string; role: TenantRole },
  ): Promise<{ keycloakId: string }>;
  sendInvite(slug: string, email: string): Promise<void>;
  setRole(slug: string, email: string, role: TenantRole): Promise<void>;
  setEnabled(slug: string, email: string, enabled: boolean): Promise<void>;
}

export class HttpIdentityClient implements IdentityClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body: object): Promise<T> {
    let r: Response;
    try {
      r = await this.doFetch(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError(502, 'identity_unavailable', 'Could not reach the identity service');
    }
    if (r.ok) return (await r.json()) as T;
    if (r.status === 409) {
      throw Errors.conflict('email_in_use', 'This email address cannot be invited');
    }
    if (r.status === 404) throw Errors.notFound();
    if (r.status === 403) throw Errors.forbidden();
    throw new AppError(502, 'identity_unavailable', 'The identity service could not do this');
  }

  invite(
    slug: string,
    input: { email: string; name: string; role: TenantRole },
  ): Promise<{ keycloakId: string }> {
    return this.call('POST', `/v1/tenants/${slug}/users`, input);
  }

  async sendInvite(slug: string, email: string): Promise<void> {
    await this.call('POST', `/v1/tenants/${slug}/users/send-invite`, { email });
  }

  async setRole(slug: string, email: string, role: TenantRole): Promise<void> {
    await this.call('PUT', `/v1/tenants/${slug}/users/role`, { email, role });
  }

  async setEnabled(slug: string, email: string, enabled: boolean): Promise<void> {
    await this.call('PUT', `/v1/tenants/${slug}/users/enabled`, { email, enabled });
  }
}
