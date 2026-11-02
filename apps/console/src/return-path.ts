// SPDX-License-Identifier: AGPL-3.0-only

/** Back to where the sign-in started: a path on this site, and nowhere else. */
export function safeReturnPath(state: unknown): string {
  const returnTo = (state as { returnTo?: unknown } | undefined)?.returnTo;
  if (typeof returnTo !== 'string') return '/';
  // A browser treats a backslash like a slash, so /\\evil.test would leave the site too.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    return '/';
  }
  return returnTo.startsWith('/callback') ? '/' : returnTo;
}
