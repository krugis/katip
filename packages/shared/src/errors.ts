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
  forbidden: (msg = 'You do not have access to this') => new AppError(403, 'forbidden', msg),
  notFound: () => new AppError(404, 'not_found', 'Not found'),
  userNotProvisioned: () =>
    new AppError(403, 'user_not_provisioned', 'This user is not set up for Kâtip in this company'),
  userDisabled: () => new AppError(403, 'user_disabled', 'This user account is disabled'),
  policyDenied: (reason: string) =>
    new AppError(403, 'policy_denied', `Blocked by company policy: ${reason}`, { reason }),
  /** Both languages: this has no user to take a language from, and its reader may be an admin. */
  embeddingUnavailable: (residency: string) =>
    new AppError(
      403,
      'embedding_unavailable',
      `Dosya arama bu şirkette kullanılamıyor: veri konumu kuralına (${residency}) uyan onaylı bir embedding modeli yok, bu yüzden metin hiçbir sağlayıcıya gönderilmedi. Dosyayı sohbete metin olarak ekleyebilir ya da şirket yöneticinizden konsolda Modeller ve politikalar ekranındaki kuralı değiştirmesini isteyebilirsiniz. / File search isn't available for this company: no approved embedding model fits its data location rule (${residency}), so the text went to no provider. You can attach the file to a chat as text, or ask your company admin to change the rule under Models and policies in the console.`,
      { residency },
    ),
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
  piiUnavailable: () =>
    new AppError(
      503,
      'pii_unavailable',
      'Personal data checks are temporarily unavailable, and company policy does not allow sending without them. Please try again shortly.',
    ),
  badRequest: (msg: string) => new AppError(400, 'bad_request', msg),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  upstream: (msg = 'All model providers failed. Please try again.') =>
    new AppError(502, 'upstream_failed', msg),
};
