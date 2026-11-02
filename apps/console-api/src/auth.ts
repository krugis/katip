// SPDX-License-Identifier: AGPL-3.0-only
// Who is calling: verifies Keycloak access tokens and turns them into a caller
// (LLD-02 §1.1, §4). The tenant comes from the token's organization claim, which
// Keycloak sets from membership, so there is no user attribute to keep in sync.
import { Errors } from '@katip/shared';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { ConsoleStore, TenantRecord, UserRecord } from './stores.js';

export const ROLES = ['provider_admin', 'tenant_admin', 'dept_manager', 'user'] as const;
export type Role = (typeof ROLES)[number];

/** Our own staff's organization (LLD-02 §1). */
export const PROVIDER_ORGANIZATION = 'provider';

export type TokenVerifier = (token: string) => Promise<JWTPayload>;

export function createVerifier(opts: {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
}): TokenVerifier {
  return async (token) => {
    const { payload } = await jwtVerify(token, opts.keys, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['RS256'],
    });
    return payload;
  };
}

export const remoteKeys = (jwksUrl: string): JWTVerifyGetKey =>
  createRemoteJWKSet(new URL(jwksUrl));

export type Caller =
  | { kind: 'provider'; sub: string; roles: Role[] }
  | { kind: 'tenant'; sub: string; roles: Role[]; tenant: TenantRecord; user: UserRecord };

const rolesOf = (claims: JWTPayload): Role[] => {
  const raw = (claims['realm_access'] as { roles?: unknown } | undefined)?.roles;
  if (!Array.isArray(raw)) return [];
  return ROLES.filter((r) => raw.includes(r));
};

/** Keycloak sends a list of aliases, or a map keyed by alias when attributes are included. */
const organizationsOf = (claims: JWTPayload): string[] => {
  const raw = claims['organization'];
  if (Array.isArray(raw)) return raw.filter((o): o is string => typeof o === 'string');
  if (raw && typeof raw === 'object') return Object.keys(raw);
  return [];
};

/** Turns a bearer token into a caller, or throws the error to return. */
export async function resolveCaller(
  authorization: string | undefined,
  verify: TokenVerifier,
  store: ConsoleStore,
): Promise<Caller> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw Errors.unauthorized('Missing bearer token');

  let claims: JWTPayload;
  try {
    claims = await verify(token);
  } catch {
    throw Errors.unauthorized('Invalid or expired token');
  }
  if (!claims.sub) throw Errors.unauthorized('Invalid or expired token');

  const roles = rolesOf(claims);
  const organizations = organizationsOf(claims);

  // Both, so one wrongly assigned role can't make a customer's user a provider admin.
  if (roles.includes('provider_admin') && organizations.includes(PROVIDER_ORGANIZATION)) {
    return { kind: 'provider', sub: claims.sub, roles };
  }

  const customer = organizations.filter((o) => o !== PROVIDER_ORGANIZATION);
  // One tenant per user (DESIGN §4), so several means something is wrong: refuse to guess.
  if (customer.length !== 1) throw Errors.forbidden('This account is not linked to one company');

  const tenant = await store.tenantBySlug(customer[0]!);
  if (!tenant) throw Errors.forbidden('This account is not linked to one company');
  if (tenant.status !== 'active') throw Errors.forbidden('This company is suspended');

  const email = claims['email'];
  const user = typeof email === 'string' ? await store.findUser(tenant.id, email) : null;
  if (!user) throw Errors.userNotProvisioned();
  if (user.status !== 'active') throw Errors.userDisabled();

  return {
    kind: 'tenant',
    sub: claims.sub,
    roles: roles.filter((r) => r !== 'provider_admin'),
    tenant,
    user,
  };
}

/**
 * Who may use a route. Provider admins may use every route; other roles must be listed.
 * With tenantParam, another tenant's id answers 404, so a caller can't tell it exists.
 */
export interface Access {
  roles: readonly Role[] | 'any';
  tenantParam?: string;
}

export function authorize(caller: Caller, access: Access, params: Record<string, unknown>): void {
  if (caller.kind === 'provider') return;
  if (access.tenantParam && params[access.tenantParam] !== caller.tenant.id) {
    throw Errors.notFound();
  }
  if (access.roles === 'any') return;
  const allowed = access.roles;
  if (!caller.roles.some((r) => allowed.includes(r))) throw Errors.forbidden();
}
