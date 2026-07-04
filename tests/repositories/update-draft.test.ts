/**
 * updateDraft() — version-guarded draft edits over mongokit 3.16's
 * `claimVersion()` CAS. Covers: managed-field rejection, journalItems
 * revalidation + totals sync, expectedVersion pinning, and the three CAS
 * loss modes (missing / left-draft / version-moved).
 */
import { describe, expect, it, vi } from 'vitest';
import { wireJournalEntryMethods } from '../../src/repositories/journal-entry.repository.js';
import { AccountingError, ConcurrencyError } from '../../src/utils/errors.js';

function createEntryDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'entry-1',
    state: 'draft',
    __v: 3,
    journalItems: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Record<string, unknown>;
}

function setup(
  doc: Record<string, unknown> | null = createEntryDoc(),
  opts: {
    orgField?: string;
    claimVersionResult?: unknown | 'echo';
    reReadDoc?: Record<string, unknown> | null;
  } = {},
) {
  const claimVersionSpy = vi
    .fn()
    .mockImplementation(
      async (
        _id: unknown,
        _transition: { field?: string; from?: number; where?: Record<string, unknown> },
        update: Record<string, unknown>,
      ) => {
        if (opts.claimVersionResult === 'echo' || opts.claimVersionResult === undefined) {
          const $set = (update.$set ?? {}) as Record<string, unknown>;
          return { ...doc, ...$set, __v: ((doc?.__v as number) ?? 0) + 1 };
        }
        return opts.claimVersionResult;
      },
    );

  // First getByQuery read returns `doc`; subsequent reads (the CAS-loss
  // re-read) return `reReadDoc` when provided.
  let reads = 0;
  const getByQuery = vi.fn().mockImplementation(async () => {
    reads += 1;
    if (reads > 1 && opts.reReadDoc !== undefined) return opts.reReadDoc;
    return doc;
  });

  const repo: Record<string, unknown> = {
    getByQuery,
    create: vi.fn(),
    update: vi.fn(),
    claim: vi.fn(),
    claimVersion: claimVersionSpy,
    Model: { db: { startSession: vi.fn() } },
  };
  const wired = wireJournalEntryMethods(
    repo as never,
    {} as never,
    opts.orgField,
  ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & {
    updateDraft: (
      id: unknown,
      patch: Record<string, unknown>,
      orgId?: unknown,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  return { wired, claimVersionSpy, getByQuery };
}

describe('updateDraft', () => {
  it('patches a draft via claimVersion CAS on __v', async () => {
    const { wired, claimVersionSpy } = setup();
    const result = (await wired.updateDraft('entry-1', { label: 'Updated label' })) as Record<
      string,
      unknown
    >;

    expect(result.label).toBe('Updated label');
    expect(claimVersionSpy).toHaveBeenCalledTimes(1);
    const [id, transition, update] = claimVersionSpy.mock.calls[0];
    expect(id).toBe('entry-1');
    expect(transition).toMatchObject({ field: '__v', from: 3, where: { state: 'draft' } });
    expect((update as { $set: Record<string, unknown> }).$set.label).toBe('Updated label');
  });

  it('pins options.expectedVersion into the CAS instead of the persisted __v', async () => {
    const { wired, claimVersionSpy } = setup();
    await wired.updateDraft('entry-1', { label: 'x' }, undefined, { expectedVersion: 7 });
    expect(claimVersionSpy.mock.calls[0][1]).toMatchObject({ from: 7 });
  });

  it('scopes the CAS where-clause by org when orgField is configured', async () => {
    const { wired, claimVersionSpy } = setup(createEntryDoc({ business: 'org-9' }), {
      orgField: 'business',
    });
    await wired.updateDraft('entry-1', { label: 'x' }, 'org-9');
    expect(claimVersionSpy.mock.calls[0][1]).toMatchObject({
      where: { state: 'draft', business: 'org-9' },
    });
  });

  it('rejects engine-managed fields', async () => {
    const { wired, claimVersionSpy } = setup();
    await expect(wired.updateDraft('entry-1', { state: 'posted' })).rejects.toThrow(
      /engine-managed/,
    );
    await expect(wired.updateDraft('entry-1', { totalDebit: 100 })).rejects.toThrow(
      /engine-managed/,
    );
    await expect(wired.updateDraft('entry-1', { referenceNumber: 'X' })).rejects.toThrow(
      /engine-managed/,
    );
    expect(claimVersionSpy).not.toHaveBeenCalled();
  });

  it('rejects operator-shaped and empty patches', async () => {
    const { wired } = setup();
    await expect(wired.updateDraft('entry-1', { $set: { label: 'x' } })).rejects.toThrow(
      /operators are not allowed/,
    );
    await expect(wired.updateDraft('entry-1', {})).rejects.toThrow(/empty/);
  });

  it('journalItems patch revalidates line shape and syncs totals into the $set', async () => {
    const { wired, claimVersionSpy } = setup();
    await wired.updateDraft('entry-1', {
      journalItems: [
        { account: 'a1', debit: 500_00, credit: 0 },
        { account: 'a2', debit: 0, credit: 300_00 },
      ],
    });
    const $set = (claimVersionSpy.mock.calls[0][2] as { $set: Record<string, unknown> }).$set;
    expect($set.totalDebit).toBe(500_00);
    expect($set.totalCredit).toBe(300_00); // drafts may be unbalanced — post() enforces balance
  });

  it('rejects a line with both debit and credit, and non-integer amounts', async () => {
    const { wired } = setup();
    await expect(
      wired.updateDraft('entry-1', { journalItems: [{ debit: 100, credit: 100 }] }),
    ).rejects.toThrow(/debit OR a credit/);
    await expect(
      wired.updateDraft('entry-1', { journalItems: [{ debit: 10.5, credit: 0 }] }),
    ).rejects.toThrow(/non-negative integers/);
  });

  it('refuses to edit a non-draft entry up front', async () => {
    const { wired, claimVersionSpy } = setup(createEntryDoc({ state: 'posted' }));
    await expect(wired.updateDraft('entry-1', { label: 'x' })).rejects.toThrow(/posted/);
    expect(claimVersionSpy).not.toHaveBeenCalled();
  });

  it('CAS loss with unchanged draft state → ConcurrencyError (version moved)', async () => {
    const { wired } = setup(createEntryDoc(), { claimVersionResult: null });
    await expect(
      wired.updateDraft('entry-1', { label: 'x' }, undefined, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it('CAS loss because the entry was posted mid-edit → immutable error', async () => {
    const { wired } = setup(createEntryDoc(), {
      claimVersionResult: null,
      reReadDoc: createEntryDoc({ state: 'posted' }),
    });
    const err = await wired.updateDraft('entry-1', { label: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountingError);
    expect((err as AccountingError).code).toBe('IMMUTABLE_ENTRY');
  });

  it('CAS loss because the entry vanished → NOT_FOUND', async () => {
    const { wired } = setup(createEntryDoc(), { claimVersionResult: null, reReadDoc: null });
    const err = await wired.updateDraft('entry-1', { label: 'x' }).catch((e: unknown) => e);
    expect((err as AccountingError).code).toBe('NOT_FOUND');
  });

  it('throws a clear error when the backend lacks claimVersion (mongokit < 3.16)', async () => {
    const { wired } = setup();
    // Simulate a legacy repo: remove claimVersion from the wired instance.
    (wired as Record<string, unknown>).claimVersion = undefined;
    await expect(wired.updateDraft('entry-1', { label: 'x' })).rejects.toThrow(/mongokit >= 3.16/);
  });
});
