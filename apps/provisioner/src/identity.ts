// SPDX-License-Identifier: AGPL-3.0-only
// What console-api may ask of Keycloak (LLD-02 §1, tracker P1-24). Keycloak's own rights are
// too broad to hold on an internet-facing service: adding a user to an organization needs
// manage-realm, which can also change the login rules, and manage-users can reset any
// password. So this offers only these actions, and refuses anything outside one company.

export const TENANT_ROLES = ['tenant_admin', 'dept_manager', 'user'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

const PROVIDER_ORGANIZATION = 'provider';
const PROVIDER_ROLE = 'provider_admin';

export interface DirectoryUser {
  id: string;
}

/** Keycloak, as this needs it. */
export interface IdentityDirectory {
  findUser(email: string): Promise<DirectoryUser | null>;
  organizationsOf(userId: string): Promise<string[]>;
  realmRolesOf(userId: string): Promise<string[]>;
  createInvitedUser(input: { email: string; name: string }): Promise<string>;
  grantMembership(slug: string, userId: string): Promise<void>;
  setRealmRole(userId: string, role: TenantRole, allRoles: readonly TenantRole[]): Promise<void>;
  setEnabled(userId: string, enabled: boolean): Promise<void>;
  endSessions(userId: string): Promise<void>;
  sendInviteEmail(slug: string, userId: string): Promise<void>;
  setClientSessionLimits(slug: string, idleSeconds: number, maxSeconds: number): Promise<void>;
}

export class IdentityRefused extends Error {
  constructor(
    public readonly status: 403 | 404 | 409,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'IdentityRefused';
  }
}

export class TenantUsers {
  constructor(private readonly directory: IdentityDirectory) {}

  private refuseProviderOrganization(slug: string): void {
    if (slug === PROVIDER_ORGANIZATION) throw new IdentityRefused(403, 'not_a_company');
  }

  /** The user, if they belong to this company and to nothing else. */
  private async member(slug: string, email: string): Promise<DirectoryUser> {
    this.refuseProviderOrganization(slug);
    const user = await this.directory.findUser(email);
    if (!user) throw new IdentityRefused(404, 'unknown_user');
    const orgs = await this.directory.organizationsOf(user.id);
    if (!orgs.includes(slug) || orgs.length !== 1) throw new IdentityRefused(404, 'unknown_user');
    const roles = await this.directory.realmRolesOf(user.id);
    if (roles.includes(PROVIDER_ROLE)) throw new IdentityRefused(403, 'provider_admin');
    return user;
  }

  /**
   * Creates the login, or links an existing one that isn't in another company. An existing
   * id must be kept: LibreChat refuses a known email arriving with a new id.
   */
  async invite(
    slug: string,
    input: { email: string; name: string; role: TenantRole },
  ): Promise<{ keycloakId: string }> {
    this.refuseProviderOrganization(slug);
    const existing = await this.directory.findUser(input.email);
    let id: string;
    if (existing) {
      const orgs = await this.directory.organizationsOf(existing.id);
      const roles = await this.directory.realmRolesOf(existing.id);
      // One answer for both, so a caller can't learn which company someone is in.
      if (orgs.some((o) => o !== slug) || roles.includes(PROVIDER_ROLE)) {
        throw new IdentityRefused(409, 'email_in_use');
      }
      id = existing.id;
      await this.directory.setEnabled(id, true);
    } else {
      id = await this.directory.createInvitedUser(input);
    }
    await this.directory.grantMembership(slug, id);
    await this.directory.setRealmRole(id, input.role, TENANT_ROLES);
    return { keycloakId: id };
  }

  async sendInvite(slug: string, email: string): Promise<void> {
    const user = await this.member(slug, email);
    await this.directory.sendInviteEmail(slug, user.id);
  }

  async setRole(slug: string, email: string, role: TenantRole): Promise<void> {
    const user = await this.member(slug, email);
    await this.directory.setRealmRole(user.id, role, TENANT_ROLES);
  }

  /** How long a login to this company's LibreChat lasts. */
  async setSessionLimits(slug: string, idleSeconds: number, maxSeconds: number): Promise<void> {
    this.refuseProviderOrganization(slug);
    await this.directory.setClientSessionLimits(slug, idleSeconds, maxSeconds);
  }

  /** Disabling also ends their sessions, so an open login can't be renewed. */
  async setEnabled(slug: string, email: string, enabled: boolean): Promise<void> {
    const user = await this.member(slug, email);
    await this.directory.setEnabled(user.id, enabled);
    if (!enabled) await this.directory.endSessions(user.id);
  }
}
