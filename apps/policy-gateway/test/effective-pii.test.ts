// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { effectivePii } from '../src/db-stores.js';

describe('effectivePii: departments may only tighten', () => {
  it('defaults to mask with no failure setting', () => {
    expect(effectivePii(null).onDetectorFailure).toBeUndefined();
    expect(effectivePii(null).mode).toBe('mask');
  });

  it('reads the tenant onDetectorFailure', () => {
    const p = effectivePii({ pii: { mode: 'mask', onDetectorFailure: 'block' } });
    expect(p.onDetectorFailure).toBe('block');
  });

  it('treats any other stored value as the default', () => {
    expect(effectivePii({ pii: { onDetectorFailure: 'nope' } }).onDetectorFailure).toBeUndefined();
  });

  it('lets a department tighten onDetectorFailure on its own', () => {
    const p = effectivePii({ pii: { mode: 'mask' } }, { onDetectorFailure: 'block' });
    expect(p).toMatchObject({ mode: 'mask', onDetectorFailure: 'block' });
  });

  it('does not let a department loosen onDetectorFailure', () => {
    const p = effectivePii(
      { pii: { mode: 'mask', onDetectorFailure: 'block' } },
      { onDetectorFailure: 'allow' },
    );
    expect(p.onDetectorFailure).toBe('block');
  });

  it('keeps the tenant block when a department tightens the mode', () => {
    const p = effectivePii(
      { pii: { mode: 'mask', onDetectorFailure: 'block' } },
      { mode: 'block' },
    );
    expect(p).toMatchObject({ mode: 'block', onDetectorFailure: 'block' });
  });

  it('still does not let a department loosen the mode', () => {
    expect(effectivePii({ pii: { mode: 'block' } }, { mode: 'off' }).mode).toBe('block');
  });
});
