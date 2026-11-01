// SPDX-License-Identifier: AGPL-3.0-only
// Policy change events (LLD-03 §2 step 3, LLD-04 admin API).
// The console publishes on this channel after editing a tenant/department
// policy; each gateway replica invalidates its effective-policy cache.

export const POLICY_CHANGED_CHANNEL = 'policy.changed';

/** Minimal publisher interface so any redis-compatible client works. */
export interface PolicyPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/** Publishes a policy change. tenantId = the affected tenant, or '*' for all. */
export function publishPolicyChanged(pub: PolicyPublisher, tenantId: string): Promise<unknown> {
  return pub.publish(POLICY_CHANGED_CHANNEL, tenantId);
}
