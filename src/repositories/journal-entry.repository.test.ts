import { describe, it, expect, vi } from 'vitest';
import { wireJournalEntryMethods } from './journal-entry.repository.js';
import type { StrictnessConfig } from '../types/engine.js';

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

/** Build a mock JournalEntryModel whose findOne returns the given doc */
function createMockJEModel(doc: Record<string, unknown> | null = null) {
  return {
    findOne: () => ({
      populate: () => ({
        session: () => Promise.resolve(doc),
      }),
      session: () => Promise.resolve(doc),
    }),
    db: {
      startSession: () => Promise.resolve({
        startTransaction: vi.fn(),
        commitTransaction: vi.fn().mockResolvedValue(undefined),
        abortTransaction: vi.fn().mockResolvedValue(undefined),
        endSession: vi.fn(),
        inTransaction: () => true,
      }),
      getClient: () => ({
        topology: { description: { type: 'ReplicaSetWithPrimary' } },
      }),
    },
  };
}

/** Create a repository mock with a create method and wire methods onto it */
function setup(
  doc: Record<string, unknown> | null = null,
  opts: { orgField?: string; strictness?: StrictnessConfig } = {},
) {
  const model = createMockJEModel(doc);
  const repo: Record<string, unknown> = {
    create: vi.fn().mockResolvedValue({ _id: 'reversal-1' }),
  };
  wireJournalEntryMethods(repo, model as any, opts.orgField, opts.strictness);
  return { repo, model };
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

    await expect((repo.post as Function)('entry-1')).rejects.toThrow(
      'at least 2 items',
    );
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

    await expect((repo.post as Function)('entry-1')).rejects.toThrow(
      'both debit and credit set',
    );
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

  it('transitions posted → draft and clears reversed flag', async () => {
    const entry = createEntryDoc({ state: 'posted', reversed: true, reversedBy: 'rev-1' });
    const { repo } = setup(entry);

    const result = await (repo.unpost as Function)('entry-1');
    expect(result.state).toBe('draft');
    expect(result.reversed).toBe(false);
    expect(result.reversedBy).toBeUndefined();
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
    const { repo } = setup(entry);

    const result = await (repo.reverse as Function)('entry-1');
    expect(result.original.reversed).toBe(true);
    expect(result.original.reversedBy).toBe('reversal-1');

    // Verify create was called with swapped amounts
    const createCall = (repo.create as any).mock.calls[0][0];
    expect(createCall.journalItems[0].debit).toBe(0);    // was credit: 0 → debit: 0
    expect(createCall.journalItems[0].credit).toBe(1000); // was debit: 1000 → credit: 1000
    expect(createCall.journalItems[1].debit).toBe(1000);  // was credit: 1000 → debit: 1000
    expect(createCall.journalItems[1].credit).toBe(0);    // was debit: 0 → credit: 0
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
    const { repo } = setup(entry);

    await (repo.reverse as Function)('entry-1', undefined, { actorId: 'user-99' });

    const createCall = (repo.create as any).mock.calls[0][0];
    expect(createCall.postedBy).toBe('user-99');
    expect(entry.reversedByUser).toBe('user-99');
  });

  it('preserves extra dimension fields on reversal items', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0, departmentId: 'dept-1', projectId: 'proj-1' },
        { account: { _id: 'a2' }, debit: 0, credit: 1000, departmentId: 'dept-2' },
      ],
    });
    const { repo } = setup(entry);

    await (repo.reverse as Function)('entry-1');

    const createCall = (repo.create as any).mock.calls[0][0];
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
    const { repo } = setup(entry);

    await (repo.duplicate as Function)('entry-1');

    const createCall = (repo.create as any).mock.calls[0][0];
    expect(createCall.state).toBe('draft');
    expect(createCall.label).toBe('Copy of Original Entry');
    expect(createCall.journalType).toBe('SALE');
    expect(createCall.journalItems).toHaveLength(2);
    expect(createCall.journalItems[0].account).toBe('a1');
  });
});
