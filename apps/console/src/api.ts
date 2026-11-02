// SPDX-License-Identifier: AGPL-3.0-only
// console-api, on the same origin. It decides who may do what: this app only reflects it.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = 'ApiError';
  }
}

export interface Me {
  roles: string[];
  tenant: { id: string; slug: string; name: string; status: string } | null;
  user: { id: string; email: string; name: string; role: string } | null;
}

export type GetToken = () => Promise<string | null>;

export async function apiFetch<T>(path: string, getToken: GetToken): Promise<T> {
  const token = await getToken();
  const res = await fetch(`/api/v1${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as { code?: string } | null;
    throw new ApiError(res.status, problem?.code ?? 'unknown');
  }
  return (await res.json()) as T;
}
