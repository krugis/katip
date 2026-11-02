// SPDX-License-Identifier: AGPL-3.0-only
export interface AppConfig {
  authority: string;
  clientId: string;
  baseDomain: string;
}

/** Served by nginx from the environment, so one image works on any domain. */
export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json');
  if (!res.ok) throw new Error(`config: HTTP ${res.status}`);
  return (await res.json()) as AppConfig;
}
