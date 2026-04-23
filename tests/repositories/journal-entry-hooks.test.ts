/**
 * Journal Entry Repository — Hook Enforcement Tests (TDD)
 *
 * Verifies that wired domain methods (post, unpost, archive, duplicate, reverse)
 * go through repository.getByQuery() instead of direct Model.findOne(),
 * ensuring all registered plugins (multi-tenant, audit, cache) fire.
 *
 * Also verifies reverse() uses repository.withTransaction() for
 * automatic retry on transient failures.
 */

import { describe, expect, it, vi } from 'vitest';
import { wireJournalEntryMethods } from '../../src/repositories/journal-entry.repository.js';
import { mockRepository } from '../helpers/mock-repository.js';

function createEntryDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'entry-1',
    state: 'draft',
    journalItems: [],
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockRepo(doc: Record<string, unknown> | null = null): any {
  return mockRepository({
    getByQuery: vi.fn().mockResolvedValue(doc),
    create: vi.fn().mockResolvedValue({ _id: 'reversal-1' }),
  });
}

// ── Hook enforcement: post() uses getByQuery ────────────────────────────────

describe('hook enforcement — post() uses repository.getByQuery', () => {
  it('calls repository.getByQuery with populate for account resolution', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).post('entry-1');

    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [query, options] = repo.getByQuery.mock.calls[0];
    expect(query).toEqual({ _id: 'entry-1' });
    expect(options).toMatchObject({ populate: 'journalItems.account', lean: false });
  });

  it('passes session through to getByQuery', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    const fakeSession = { id: 'session-1' };
    await (repo as any).post('entry-1', undefined, { session: fakeSession });

    const [, options] = repo.getByQuery.mock.calls[0];
    expect(options.session).toBe(fakeSession);
  });
});

// ── Hook enforcement: unpost() uses getByQuery ──────────────────────────────

describe('hook enforcement — unpost() uses repository.getByQuery', () => {
  it('calls repository.getByQuery without populate', async () => {
    const entry = createEntryDoc({ state: 'posted' });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).unpost('entry-1');

    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [query, options] = repo.getByQuery.mock.calls[0];
    expect(query).toEqual({ _id: 'entry-1' });
    expect(options).toMatchObject({ lean: false });
    // unpost doesn't need populate
    expect(options.populate).toBeUndefined();
  });
});

// ── Hook enforcement: archive() uses getByQuery ─────────────────────────────

describe('hook enforcement — archive() uses repository.getByQuery', () => {
  it('calls repository.getByQuery without populate', async () => {
    const entry = createEntryDoc({ state: 'draft' });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).archive('entry-1');

    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [query, options] = repo.getByQuery.mock.calls[0];
    expect(query).toEqual({ _id: 'entry-1' });
    expect(options).toMatchObject({ lean: false });
  });
});

// ── Hook enforcement: duplicate() uses getByQuery ───────────────────────────

describe('hook enforcement — duplicate() uses repository.getByQuery', () => {
  it('calls repository.getByQuery without populate', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalType: 'SALE',
      label: 'Test',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).duplicate('entry-1');

    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [query, options] = repo.getByQuery.mock.calls[0];
    expect(query).toEqual({ _id: 'entry-1' });
    expect(options).toMatchObject({ lean: false });
  });
});

// ── Hook enforcement: reverse() wraps itself in a transaction ───────────────
//
// reverse() uses a local helper built around mongokit's standalone
// `withTransaction(connection, fn)` (see journal-entry.repository.ts near
// line 185). Session threading spans multiple collaborators (other repos,
// event publisher), so the 3.10 instance method `repository.withTransaction`
// (which hands back a tx-bound repo) would not fit — hence the closure.
// These tests assert the session-starter contract by inspecting the fake
// `Model.db.startSession` spy surfaced by `mockRepository`.

describe('hook enforcement — reverse() opens a transaction on the connection', () => {
  it('starts a session when no external session is provided', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).reverse('entry-1');

    const startSession = (repo as any).Model.db.startSession as ReturnType<typeof vi.fn>;
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [, options] = repo.getByQuery.mock.calls[0];
    expect(options).toMatchObject({ populate: 'journalItems.account', lean: false });
  });

  it('skips opening a session when an external session is provided', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    const fakeSession = { id: 'ext-session' };
    await (repo as any).reverse('entry-1', undefined, { session: fakeSession });

    const startSession = (repo as any).Model.db.startSession as ReturnType<typeof vi.fn>;
    // Caller manages the transaction — reverse() must not open a new one.
    expect(startSession).not.toHaveBeenCalled();
    expect(repo.getByQuery).toHaveBeenCalledTimes(1);
    const [, options] = repo.getByQuery.mock.calls[0];
    expect(options.session).toBe(fakeSession);
  });

  it('threads the opened session into getByQuery so plugins see the tx', async () => {
    const entry = createEntryDoc({
      state: 'posted',
      journalItems: [
        { account: { _id: 'a1' }, debit: 500, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 500 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await (repo as any).reverse('entry-1');

    // The fake session returned by startSession is the value threaded
    // through to every collaborator call — assert getByQuery received it.
    const startSessionSpy = (repo as any).Model.db.startSession as ReturnType<typeof vi.fn>;
    const fakeSession = await startSessionSpy.mock.results[0].value;
    const [, getOptions] = repo.getByQuery.mock.calls[0];
    expect(getOptions.session).toBe(fakeSession);
  });
});

// ── Account existence validation on post() ──────────────────────────────────

describe('post() account existence validation', () => {
  it('rejects when populated account is null (caught by missing-account check)', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: null, debit: 1000, credit: 0 }, // populate returned null
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await expect((repo as any).post('entry-1')).rejects.toThrow('missing an account');
  });

  it('rejects when populated account is a string (populate failed)', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: '507f1f77bcf86cd799439011', debit: 1000, credit: 0 }, // ObjectId string — not populated
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await expect((repo as any).post('entry-1')).rejects.toThrow('do not exist');
  });

  it('passes when all accounts are populated objects with _id', async () => {
    const entry = createEntryDoc({
      state: 'draft',
      journalItems: [
        { account: { _id: 'a1' }, debit: 1000, credit: 0 },
        { account: { _id: 'a2' }, debit: 0, credit: 1000 },
      ],
    });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    const result = await (repo as any).post('entry-1');
    expect(result.state).toBe('posted');
  });
});

// ── Unpost rejects reversed entries ─────────────────────────────────────────

describe('unpost() reversed entry protection', () => {
  it('rejects unpost on reversed entry to prevent inconsistent state', async () => {
    const entry = createEntryDoc({ state: 'posted', reversed: true, reversedBy: 'rev-1' });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    await expect((repo as any).unpost('entry-1')).rejects.toThrow('Cannot unpost a reversed entry');
  });

  it('allows unpost on non-reversed posted entry', async () => {
    const entry = createEntryDoc({ state: 'posted', reversed: false });
    const repo = createMockRepo(entry);
    wireJournalEntryMethods(repo, {} as any);

    const result = await (repo as any).unpost('entry-1');
    expect(result.state).toBe('draft');
  });
});
