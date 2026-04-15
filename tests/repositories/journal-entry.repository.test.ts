import { describe, expect, it, vi } from 'vitest';
import { wireJournalEntryMethods } from '../../src/repositories/journal-entry.repository.js';
import type { StrictnessConfig } from '../../src/types/engine.js';

/** Build a fake Mongoose entry document */
function createEntryDoc(overrides: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = {
    _id: 'entry-1',
    state: 'draft',
    journalItems: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return doc;
}

/** Create a repository mock with getByQuery/create/withTransaction and wire methods onto it */
function setup(
  doc: Record<string, unknown> | null = null,
  opts: { orgField?: string; strictness?: StrictnessConfig } = {},
) {
  // 0.9.0: capture the original create spy before wireJournalEntryMethods
  // installs its race-safe wrapper. Tests that assert on `create` call
  // arguments should use `createSpy` directly instead of `repo.create`,
  // because the wrapper's `.mock` is not the original spy.
  const createSpy = vi.fn().mockResolvedValue({ _id: 'reversal-1' });
  const repo: Record<string, unknown> = {
    getByQuery: vi.fn().mockResolvedValue(doc),
    create: createSpy,
    // post/unpost/archive now route their state mutations through update() so
    // the plugin pipeline fires. The mock echoes back the patched doc so the
    // assertions on the returned entry continue to work.
    update: vi.fn().mockImplementation(async (_id: unknown, patch: Record<string, unknown>) => ({
      ...(doc as Record<string, unknown>),
      ...patch,
    })),
    withTransaction: vi
      .fn()
      .mockImplementation(async (cb: (session: unknown) => Promise<unknown>) => cb(null)),
  };
  wireJournalEntryMethods(repo as any, {} as any, opts.orgField, opts.strictness);
  return { repo, createSpy };
}

// ── post() ────────────────────────────────────────────────────────────────

describe('wireJournalEntryMethods — post()', () => {
  it('throws when requireActor is true but no actorId provided', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const { repo } = setup(entry, { strictness: { requireActor: true } });

    await expect((repo.post as Function)('entry-1', 'org-1', {})).rejects.toThrow(
      'actorId is required for post operations',
    );
  });

  it('succeeds when requireActor is true and actorId is provided', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const { repo } = setup(entry, { strictness: { requireActor: true } });

    const result = await (repo.post as Function)('entry-1', 'org-1', { actorId: 'user-1' });
    expect(result.state).toBe('posted');
    expect(result.postedBy).toBe('user-1');
  });

  it('throws when requireApproval is true but approvedBy/approvedAt missing', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const { repo } = setup(entry, { strictness: { requireApproval: true } });

    await expect((repo.post as Function)('entry-1', 'org-1')).rejects.toThrow(
      'Entry must be approved before posting',
    );
  });

  it('allows posting when requireApproval is true and both approvedBy and approvedAt are set', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      approvedBy: 'approver-1',
      approvedAt: new Date(),
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const { repo } = setup(entry, { strictness: { requireApproval: true } });

    const result = await (repo.post as Function)('entry-1', 'org-1');
    expect(result.state).toBe('posted');
  });

  it('throws when entry is not found', async () => {
    const { repo } = setup(null);
    await expect((repo.post as Function)('nonexistent')).rejects.toThrow('Entry not found');
  });

  it('throws when entry is not in draft state', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow(
      'Only draft entries can be posted',
    );
  });

  it('returns entry as-is when already posted with idempotency key', async () => {
    const entry = createEntryDoc({ state: 'posted', idempotencyKey: 'idem-1' });
    const { repo } = setup(entry);

    const result = await (repo.post as Function)('entry-1');
    expect(result).toBe(entry);
    expect(entry.save).not.toHaveBeenCalled();
  });

  it('throws when fewer than 2 journal items', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [{ account: { _id: 'a1' }, debit: 1000, credit: 0 }],
    });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow('at least 2 items');
  });

  it('throws when an item has no account', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: 'a1', debit: 1000, credit: 0 },
        { account: '', debit: 0, credit: 1000 },
      ],
    });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow('missing an account');
  });

  it('throws when items have both debit and credit as zero', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 0 },
      ],
    });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow(
      'both debit and credit as zero',
    );
  });

  it('throws when an item has both debit and credit > 0', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 500 },
        { account: { _id: 'a2' }, debit: 0, credit: 500 },
      ],
    });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow('both debit and credit set');
  });

  it('throws when entry is not balanced', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 999 },
      ],
    });
    const { repo } = setup(entry);

    await expect((repo.post as Function)('entry-1')).rejects.toThrow('not balanced');
  });

  it('detects cross-tenant accounts when orgField is set', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      business: 'org-1',
      journalItems: [
        { account: { _id: 'a1', business: 'org-1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2', business: 'org-2' }, debit: 0, credit: 1000 },
      ],
    });
    const { repo } = setup(entry, { orgField: 'business' });

    await expect((repo.post as Function)('entry-1', 'org-1')).rejects.toThrow(
      'accounts from another organization',
    );
  });
});

// ── unpost() ──────────────────────────────────────────────────────────────

describe('wireJournalEntryMethods — unpost()', () => {
  it('throws when immutable strictness is enabled', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry, { strictness: { immutable: true } });

    await expect((repo.unpost as Function)('entry-1')).rejects.toThrow(
      'Unpost is disabled in strict mode',
    );
  });

  it('throws when requireActor is true but no actorId provided', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry, { strictness: { requireActor: true } });

    await expect((repo.unpost as Function)('entry-1', 'org-1', {})).rejects.toThrow(
      'actorId is required for unpost operations',
    );
  });

  it('throws when entry is not posted', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const { repo } = setup(entry);

    await expect((repo.unpost as Function)('entry-1')).rejects.toThrow(
      'Only posted entries can be unposted',
    );
  });

  it('transitions posted → draft', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry);

    const result = await (repo.unpost as Function)('entry-1');
    expect(result.state).toBe('draft');
  });

  it('rejects unpost on a reversed entry (prevents inconsistent state)', async () => {
    const entry = createEntryDoc({ state: 'posted', reversed: true, reversedBy: 'rev-1' });
    const { repo } = setup(entry);

    await expect((repo.unpost as Function)('entry-1')).rejects.toThrow(
      'Cannot unpost a reversed entry',
    );
  });
});

// ── archive() ─────────────────────────────────────────────────────────────

describe('wireJournalEntryMethods — archive()', () => {
  it('throws when requireActor is true but no actorId', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const { repo } = setup(entry, { strictness: { requireActor: true } });

    await expect((repo.archive as Function)('entry-1', 'org-1', {})).rejects.toThrow(
      'actorId is required for archive operations',
    );
  });

  it('throws when entry is not in draft state', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry);

    await expect((repo.archive as Function)('entry-1')).rejects.toThrow(
      'Only draft entries can be archived',
    );
  });

  it('transitions draft → archived', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const { repo } = setup(entry);

    const result = await (repo.archive as Function)('entry-1');
    expect(result.state).toBe('archived');
  });
});

// ── reverse() ─────────────────────────────────────────────────────────────

describe('wireJournalEntryMethods — reverse()', () => {
  it('throws when requireActor is true but no actorId', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const { repo } = setup(entry, { strictness: { requireActor: true } });

    await expect((repo.reverse as Function)('entry-1', 'org-1', {})).rejects.toThrow(
      'actorId is required for reverse operations',
    );
  });

  it('throws when entry is not posted', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const { repo } = setup(entry);

    await expect((repo.reverse as Function)('entry-1')).rejects.toThrow(
      'Only posted entries can be reversed',
    );
  });

  it('throws when entry is already reversed', async () => {
    const entry = createEntryDoc({ state: 'posted', reversed: true });
    const { repo } = setup(entry);

    await expect((repo.reverse as Function)('entry-1')).rejects.toThrow(
      'Entry has already been reversed',
    );
  });

  it('creates a reversal entry with swapped debits/credits', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalType: 'SALE',
      referenceNumber: 'JE-001',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0, label: 'Cash in' },
        { account: { _id: 'a2' }, debit: 0, credit: 1000, label: 'Revenue' },
      ],
    });
    const { repo, createSpy } = setup(entry);

    const result = await (repo.reverse as Function)('entry-1');
    expect(result.original.reversed).toBe(true);
    expect(result.original.reversedBy).toBe('reversal-1');

    // Verify create was called with swapped amounts
    const createCall = (createSpy as any).mock.calls[0][0];
    expect(createCall.journalItems[0].debit).toBe(0); // was credit: 0 → debit: 0
    expect(createCall.journalItems[0].credit).toBe(1000); // was debit: 1000 → credit: 1000
    expect(createCall.journalItems[1].debit).toBe(1000); // was credit: 1000 → debit: 1000
    expect(createCall.journalItems[1].credit).toBe(0); // was debit: 0 → credit: 0
    expect(createCall.label).toBe('Reversal of JE-001');
    expect(createCall.state).toBe('posted');
    expect(createCall.reversalOf).toBe('entry-1');
  });

  it('stamps actorId on reversal entry and original', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        { account: { _id: 'a1' }, debit: 500, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 500 },
      ],
    });
    const { repo, createSpy } = setup(entry);

    await (repo.reverse as Function)('entry-1', undefined, { actorId: 'user-99' });

    const createCall = (createSpy as any).mock.calls[0][0];
    expect(createCall.postedBy).toBe('user-99');

    // The reverse-mark step now routes through repository.update() — assert
    // the actor stamp was in the patch instead of on the raw mongoose doc.
    expect(repo.update).toHaveBeenCalledWith(
      'entry-1',
      expect.objectContaining({ reversedByUser: 'user-99' }),
      expect.objectContaining({ _ledgerInternal: 'reverseMark' }),
    );
  });

  it('preserves extra dimension fields on reversal items', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        {
          account: { _id: 'a1' },
          debit: 1000,
          credit: 0,
          departmentId: 'dept-1',
          projectId: 'proj-1',
        },
        { account: { _id: 'a2' }, debit: 0, credit: 1000, departmentId: 'dept-2' },
      ],
    });
    const { repo, createSpy } = setup(entry);

    await (repo.reverse as Function)('entry-1');

    const createCall = (createSpy as any).mock.calls[0][0];
    expect(createCall.journalItems[0].departmentId).toBe('dept-1');
    expect(createCall.journalItems[0].projectId).toBe('proj-1');
    expect(createCall.journalItems[1].departmentId).toBe('dept-2');
  });
});

// ── duplicate() ───────────────────────────────────────────────────────────

describe('wireJournalEntryMethods — duplicate()', () => {
  it('throws when entry is not found', async () => {
    const { repo } = setup(null);
    await expect((repo.duplicate as Function)('nonexistent')).rejects.toThrow('Entry not found');
  });

  it('creates a draft copy with "Copy of" label', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalType: 'SALE',
      label: 'Original Entry',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0, label: 'line 1' },
        { account: { _id: 'a2' }, debit: 0, credit: 1000, label: 'line 2' },
      ],
    });
    const { repo, createSpy } = setup(entry);

    await (repo.duplicate as Function)('entry-1');

    const createCall = (createSpy as any).mock.calls[0][0];
    expect(createCall.state).toBe('draft');
    expect(createCall.label).toBe('Copy of Original Entry');
    expect(createCall.journalType).toBe('SALE');
    expect(createCall.journalItems).toHaveLength(2);
    expect(createCall.journalItems[0].account).toBe('a1');
  });
});
