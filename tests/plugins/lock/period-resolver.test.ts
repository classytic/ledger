/**
 * Unit tests for `periodResolver` — range-based lock lookup.
 *
 * Uses a hand-rolled mongoose-model-shape stub because these tests are
 * about the resolver's query shape and return behavior, not the DB.
 * Round-trip MongoDB coverage lives in the integration suite.
 */

import { describe, expect, it, vi } from 'vitest';
import { periodResolver } from '../../../src/plugins/lock/period-resolver.js';
import type { LockResolverContext } from '../../../src/plugins/lock/types.js';

function createModel(result: Record<string, unknown> | null) {
  const findOne = vi.fn(() => ({
    session: () => ({ lean: () => Promise.resolve(result) }),
  }));
  return { findOne } as unknown as Parameters<typeof periodResolver>[0]['PeriodModel'] & {
    findOne: ReturnType<typeof vi.fn>;
  };
}

function ctx(overrides: Partial<LockResolverContext> = {}): LockResolverContext {
  return {
    entryDate: new Date('2026-02-15'),
    orgValue: undefined,
    session: null,
    data: {},
    repositoryContext: {} as LockResolverContext['repositoryContext'],
    ...overrides,
  };
}

describe('periodResolver', () => {
  it('returns null when no closed period matches', async () => {
    const model = createModel(null);
    const resolve = periodResolver({ scope: 'fiscal', PeriodModel: model });
    await expect(resolve(ctx())).resolves.toBeNull();
  });

  it('returns a LockHit when the entry date falls in a closed period', async () => {
    const model = createModel({
      name: 'Q1 2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-03-31'),
      closed: true,
    });
    const resolve = periodResolver({ scope: 'fiscal', PeriodModel: model });
    const hit = await resolve(ctx());
    expect(hit).toEqual({
      scope: 'fiscal',
      label: 'Q1 2026',
      subType: undefined,
      externalRef: undefined,
    });
  });

  it('uses configurable field names for tax-period style docs', async () => {
    const model = createModel({
      jurisdiction: 'BD-DHA',
      taxType: 'VAT',
      periodStart: new Date('2026-02-01'),
      periodEnd: new Date('2026-02-28'),
      status: 'filed',
      returnRef: 'NBR-VAT-2026-02-001',
    });
    const resolve = periodResolver({
      scope: 'tax',
      PeriodModel: model,
      startField: 'periodStart',
      endField: 'periodEnd',
      closedField: 'status',
      closedValue: { $ne: 'open' },
      labelField: 'jurisdiction',
      subTypeField: 'taxType',
      externalRefField: 'returnRef',
    });
    const hit = await resolve(ctx());
    expect(hit).toMatchObject({
      scope: 'tax',
      label: 'BD-DHA',
      subType: 'VAT',
      externalRef: 'NBR-VAT-2026-02-001',
    });
    // And the query was built correctly
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        periodStart: { $lte: expect.any(Date) },
        periodEnd: { $gte: expect.any(Date) },
        status: { $ne: 'open' },
      }),
    );
  });

  it('enforces orgField presence when configured', async () => {
    const model = createModel(null);
    const resolve = periodResolver({
      scope: 'fiscal',
      PeriodModel: model,
      orgField: 'organizationId',
    });
    await expect(resolve(ctx({ orgValue: undefined }))).rejects.toThrow(
      /orgField "organizationId"/,
    );
  });

  it('adds orgValue to the query when configured', async () => {
    const model = createModel(null);
    const resolve = periodResolver({
      scope: 'fiscal',
      PeriodModel: model,
      orgField: 'organizationId',
    });
    await resolve(ctx({ orgValue: 'org-1' }));
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('merges extraQuery results into the lookup', async () => {
    const model = createModel(null);
    const resolve = periodResolver({
      scope: 'tax',
      PeriodModel: model,
      extraQuery: (c) => ({ taxType: c.data.taxType }),
    });
    await resolve(ctx({ data: { taxType: 'VAT' } }));
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ taxType: 'VAT' }),
    );
  });
});
