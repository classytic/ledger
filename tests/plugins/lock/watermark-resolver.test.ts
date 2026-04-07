/**
 * Unit tests for `watermarkResolver` — single-date cutoff.
 */

import { describe, expect, it } from 'vitest';
import type { LockResolverContext } from '../../../src/plugins/lock/types.js';
import { watermarkResolver } from '../../../src/plugins/lock/watermark-resolver.js';

function ctx(entryDate: Date, orgValue: unknown = 'org-1'): LockResolverContext {
  return {
    entryDate,
    orgValue,
    session: null,
    data: {},
    repositoryContext: {} as LockResolverContext['repositoryContext'],
  };
}

describe('watermarkResolver', () => {
  it('allows entries strictly after the watermark', async () => {
    const resolve = watermarkResolver({
      scope: 'daily',
      getWatermark: async () => new Date('2026-02-10'),
    });
    await expect(resolve(ctx(new Date('2026-02-11')))).resolves.toBeNull();
  });

  it('blocks entries on or before the watermark', async () => {
    const resolve = watermarkResolver({
      scope: 'daily',
      getWatermark: async () => new Date('2026-02-10T12:00:00Z'),
    });
    const blockedOn = await resolve(ctx(new Date('2026-02-10T12:00:00Z')));
    expect(blockedOn).toMatchObject({ scope: 'daily' });
    const blockedBefore = await resolve(ctx(new Date('2026-02-09')));
    expect(blockedBefore).toMatchObject({ scope: 'daily' });
  });

  it('returns null when getWatermark returns null', async () => {
    const resolve = watermarkResolver({
      scope: 'daily',
      getWatermark: async () => null,
    });
    await expect(resolve(ctx(new Date('1970-01-01')))).resolves.toBeNull();
  });

  it('passes orgValue and session to getWatermark', async () => {
    let received: unknown;
    const resolve = watermarkResolver({
      scope: 'daily',
      getWatermark: (org) => {
        received = org;
        return null;
      },
    });
    await resolve(ctx(new Date('2026-02-15'), 'branch-42'));
    expect(received).toBe('branch-42');
  });

  it('honors formatLabel override', async () => {
    const resolve = watermarkResolver({
      scope: 'daily',
      getWatermark: async () => new Date('2026-02-10'),
      formatLabel: () => 'branch locked',
    });
    const hit = await resolve(ctx(new Date('2026-02-05')));
    expect(hit?.label).toBe('branch locked');
  });
});
