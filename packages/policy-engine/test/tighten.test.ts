// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, tightenPolicy } from '../src/index.js';

const base = { ...DEFAULT_POLICY, allowedModels: ['a', 'b'], atQuotaLimit: 'downgrade' as const };

describe('a department over its company', () => {
  it('changes nothing with no override', () => {
    expect(tightenPolicy(base, {})).toEqual(base);
  });

  it('can turn an alias off', () => {
    const { aliases } = tightenPolicy(base, { aliases: { ...base.aliases, best: false } });
    expect(aliases.best).toBe(false);
    expect(aliases.fast).toBe(true);
  });

  it('cannot turn on what the company has off, even if stored before the company changed', () => {
    const company = { ...base, aliases: { ...base.aliases, best: false } };
    const { aliases } = tightenPolicy(company, { aliases: { ...base.aliases, best: true } });
    expect(aliases.best).toBe(false);
  });

  it('can narrow the models, and not widen them', () => {
    expect(tightenPolicy(base, { allowedModels: ['a'] }).allowedModels).toEqual(['a']);
    expect(tightenPolicy(base, { allowedModels: ['a', 'z'] }).allowedModels).toEqual(['a']);
  });

  it('with nothing in common keeps the company list, and never means every model', () => {
    expect(tightenPolicy(base, { allowedModels: ['z'] }).allowedModels).toEqual(['a', 'b']);
  });

  it('can narrow a company that allows every model', () => {
    const company = { ...base, allowedModels: [] };
    expect(tightenPolicy(company, { allowedModels: ['z'] }).allowedModels).toEqual(['z']);
  });

  it('can only be stricter at the quota limit', () => {
    expect(tightenPolicy(base, { atQuotaLimit: 'block' }).atQuotaLimit).toBe('block');
    expect(tightenPolicy(base, { atQuotaLimit: 'overage' }).atQuotaLimit).toBe('downgrade');
  });
});
