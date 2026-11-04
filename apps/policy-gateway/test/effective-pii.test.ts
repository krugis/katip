// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { effectivePii, strictestPii } from '../src/db-stores.js';

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

describe('strictestPii: a service key, which has no department', () => {
  it('is the company policy when no department has a rule', () => {
    const p = strictestPii({ pii: { mode: 'mask' } }, [undefined, {}]);
    expect(p.mode).toBe('mask');
    expect(p.entities?.TR_TCKN).toBe('mask');
    expect(p.onDetectorFailure).toBeUndefined();
  });

  it("takes one department's block over everyone else's mask", () => {
    const p = strictestPii({ pii: { mode: 'mask' } }, [{ mode: 'mask' }, { mode: 'block' }, {}]);
    expect(p.mode).toBe('block');
    expect(p.entities?.TR_TCKN).toBe('block');
    expect(p.entities?.PERSON).toBe('block');
  });

  it('takes a block on one kind, leaving the others', () => {
    const p = strictestPii({ pii: { mode: 'mask' } }, [{ entities: { TR_IBAN: 'block' } }]);
    expect(p.mode).toBe('mask');
    expect(p.entities?.TR_IBAN).toBe('block');
    expect(p.entities?.TR_TCKN).toBe('mask');
  });

  it("can't be loosened by a department, whole or by kind", () => {
    const p = strictestPii({ pii: { mode: 'block', entities: { PERSON: 'mask' } } }, [
      { mode: 'off' },
      { entities: { TR_TCKN: 'off', PERSON: 'off' } },
    ]);
    expect(p.mode).toBe('block');
    expect(p.entities?.TR_TCKN).toBe('block');
    expect(p.entities?.PERSON).toBe('mask');
  });

  it('takes a department that only tightens what happens when the detector fails', () => {
    expect(strictestPii(null, [{ onDetectorFailure: 'block' }]).onDetectorFailure).toBe('block');
    expect(
      strictestPii({ pii: { onDetectorFailure: 'block' } }, [{ onDetectorFailure: 'allow' }])
        .onDetectorFailure,
    ).toBe('block');
  });

  it('ignores a stored value that means nothing', () => {
    const bad = { mode: 'constructor', entities: { TR_TCKN: 'nope' } } as never;
    const p = strictestPii({ pii: { mode: 'mask' } }, [bad]);
    expect(p.mode).toBe('mask');
    expect(p.entities?.TR_TCKN).toBe('mask');
  });
});
