// SPDX-License-Identifier: AGPL-3.0-only

/** RFC 9457 problem details. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  code: string;
  [extension: string]: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extensions: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  toProblem(): ProblemDetails {
    return {
      type: `https://katip.dev/problems/${this.code}`,
      title: this.message,
      status: this.status,
      code: this.code,
      ...this.extensions,
    };
  }

  /** OpenAI-compatible error body, so LibreChat shows a readable message. */
  toOpenAIError(): { error: { message: string; type: string; code: string } } {
    return { error: { message: this.message, type: openAIType(this.status), code: this.code } };
  }
}

function openAIType(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

export const Errors = {
  unauthorized: (msg = 'Invalid or missing API key') => new AppError(401, 'unauthorized', msg),
  userNotProvisioned: () =>
    new AppError(403, 'user_not_provisioned', 'This user is not set up for Kâtip in this company'),
  userDisabled: () => new AppError(403, 'user_disabled', 'This user account is disabled'),
  policyDenied: (reason: string) =>
    new AppError(403, 'policy_denied', `Blocked by company policy: ${reason}`, { reason }),
  quotaExceeded: (cls: string) =>
    new AppError(
      429,
      'quota_exceeded',
      `Your company's monthly ${cls} usage limit is reached. Ask your admin to raise it.`,
      { quotaClass: cls },
    ),
  piiBlocked: (types: string[]) =>
    new AppError(
      400,
      'pii_blocked',
      `Message contains personal data that company policy does not allow to send: ${types.join(', ')}`,
      { entityTypes: types },
    ),
  badRequest: (msg: string) => new AppError(400, 'bad_request', msg),
  upstream: (msg = 'All model providers failed. Please try again.') =>
    new AppError(502, 'upstream_failed', msg),
};
