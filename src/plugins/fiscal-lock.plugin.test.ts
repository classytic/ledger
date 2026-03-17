import { describe, it, expect } from 'vitest';
import { fiscalLockPlugin } from './fiscal-lock.plugin.js';

/** Minimal mock repo — captures hooks registered by plugins */
function createMockRepo() {
  const hooks = new Map<string, Array<(ctx: unknown) => void | Promise<void>>>();
  return {
    on(event: string, handler: (ctx: unknown) => void | Promise<void>) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event)!.push(handler);
    },
    async emit(event: string, ctx: unknown) {
      for (const fn of hooks.get(event) ?? []) {
        await fn(ctx);
      }
    },
  };
}

/** Mock FiscalPeriodModel — returns a closed period or null */
function createFPModel(closedPeriod: Record<string, unknown> | null) {
  return {
    findOne: () => ({
      session: () => ({
        lean: () => Promise.resolve(closedPeriod),
      }),
    }),
  } as any;
}

/** Mock JournalEntryModel for fetching persisted date */
function createJEModel(entry: Record<string, unknown> | null) {
  return {
    findById: () => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve(entry),
        }),
      }),
    }),
  } as any;
}

describe('fiscalLockPlugin', () => {
  // ── before:create ──────────────────────────────────────────────────────────

  describe('before:create', () => {
    it('allows posting when no closed period exists', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-03-15') };
      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('blocks posting in a closed period', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel({
          name: 'Q1 2025',
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-03-31'),
          closed: true,
        }),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-03-15') };
      await expect(
        repo.emit('before:create', { data }),
      ).rejects.toThrow('fiscal period "Q1 2025" is closed');
    });

    it('skips check for draft entries', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel({
          name: 'Q1 2025',
          closed: true,
        }),
      }).apply(repo);

      const data = { state: 'draft', date: new Date('2025-03-15') };
      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('checks fiscal lock using current date when posted create has no explicit date', async () => {
      // This ensures the lock isn't bypassed when schema will default the date later
      let capturedQuery: Record<string, unknown> | undefined;
      const fpModel = {
        findOne: (q: Record<string, unknown>) => {
          capturedQuery = q;
          return { session: () => ({ lean: () => Promise.resolve(null) }) };
        },
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({ FiscalPeriodModel: fpModel }).apply(repo);

      const data = { state: 'posted' }; // no date
      await repo.emit('before:create', { data });

      // Should have queried with a date (current date), not skipped
      expect(capturedQuery).toBeDefined();
      expect(capturedQuery!.startDate).toBeDefined();
      expect(capturedQuery!.endDate).toBeDefined();
    });
  });

  // ── before:update — partial update date handling ───────────────────────────

  describe('before:update (partial update)', () => {
    it('uses date from payload when present', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-06-15') };
      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('throws config error when state=posted, no date, and JournalEntryModel not provided', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel(null),
        // No JournalEntryModel!
      }).apply(repo);

      const data = { state: 'posted' }; // no date

      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('JournalEntryModel is required');
    });

    it('fetches persisted date when JournalEntryModel is provided', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel(null), // No closed period
        JournalEntryModel: createJEModel({ date: new Date('2025-06-15') }),
      }).apply(repo);

      const data = { state: 'posted' }; // no date in payload
      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('blocks posting when persisted date falls in closed period', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel({
          name: 'Q1 2025',
          closed: true,
        }),
        JournalEntryModel: createJEModel({ date: new Date('2025-02-15') }),
      }).apply(repo);

      const data = { state: 'posted' }; // no date
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('fiscal period "Q1 2025" is closed');
    });

    it('throws when context.id is missing on partial post update', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel(null),
        JournalEntryModel: createJEModel({ date: new Date('2025-06-15') }),
      }).apply(repo);

      const data = { state: 'posted' }; // no date, no id
      await expect(
        repo.emit('before:update', { data }), // no id in context
      ).rejects.toThrow('update context is missing "id"');
    });

    it('skips check for non-posted updates', async () => {
      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: createFPModel({
          name: 'Q1 2025',
          closed: true,
        }),
      }).apply(repo);

      const data = { label: 'updated', state: 'draft' };
      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });
  });

  // ── Multi-tenant scoping ──────────────────────────────────────────────────

  describe('multi-tenant', () => {
    it('scopes fiscal period query by org field from data', async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      const fpModel = {
        findOne: (q: Record<string, unknown>) => {
          capturedQuery = q;
          return { session: () => ({ lean: () => Promise.resolve(null) }) };
        },
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: fpModel,
        orgField: 'business',
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-03-15'), business: 'org123' };
      await repo.emit('before:create', { data });

      expect(capturedQuery).toBeDefined();
      expect(capturedQuery!.business).toBe('org123');
    });

    it('fetches org field from persisted doc on partial update when not in payload or context', async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      const fpModel = {
        findOne: (q: Record<string, unknown>) => {
          capturedQuery = q;
          return { session: () => ({ lean: () => Promise.resolve(null) }) };
        },
      } as any;

      const jeModel = {
        findById: () => ({
          select: (fields: string) => {
            // Verify both date and org field are selected
            expect(fields).toContain('date');
            expect(fields).toContain('business');
            return {
              session: () => ({
                lean: () => Promise.resolve({ date: new Date('2025-03-15'), business: 'org456' }),
              }),
            };
          },
        }),
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: fpModel,
        JournalEntryModel: jeModel,
        orgField: 'business',
      }).apply(repo);

      // Partial update: no date, no business in payload
      const data = { state: 'posted' };
      await repo.emit('before:update', { id: 'abc', data });

      expect(capturedQuery).toBeDefined();
      expect(capturedQuery!.business).toBe('org456');
    });

    it('fetches org field separately when date is in payload but org is not', async () => {
      let capturedQuery: Record<string, unknown> | undefined;
      const fpModel = {
        findOne: (q: Record<string, unknown>) => {
          capturedQuery = q;
          return { session: () => ({ lean: () => Promise.resolve(null) }) };
        },
      } as any;

      const jeModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve({ business: 'org789' }),
            }),
          }),
        }),
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: fpModel,
        JournalEntryModel: jeModel,
        orgField: 'business',
      }).apply(repo);

      // Update has date but NOT business in payload
      const data = { state: 'posted', date: new Date('2025-06-15') };
      await repo.emit('before:update', { id: 'abc', data });

      expect(capturedQuery).toBeDefined();
      expect(capturedQuery!.business).toBe('org789');
    });

    it('throws when orgField is configured but cannot be resolved from any source', async () => {
      const fpModel = {
        findOne: () => ({ lean: () => Promise.resolve(null) }),
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: fpModel,
        orgField: 'business',
        // No JournalEntryModel, so can't fetch persisted doc
      }).apply(repo);

      // Create with org field configured but not in data
      const data = { state: 'posted', date: new Date('2025-03-15') };
      await expect(
        repo.emit('before:create', { data }),
      ).rejects.toThrow('could not be resolved');
    });

    it('throws on update when orgField cannot be resolved even from persisted doc', async () => {
      const fpModel = {
        findOne: () => ({ lean: () => Promise.resolve(null) }),
      } as any;

      const jeModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              // Persisted doc exists but has no business field
              lean: () => Promise.resolve({ date: new Date('2025-06-15') }),
            }),
          }),
        }),
      } as any;

      const repo = createMockRepo();
      fiscalLockPlugin({
        FiscalPeriodModel: fpModel,
        JournalEntryModel: jeModel,
        orgField: 'business',
      }).apply(repo);

      const data = { state: 'posted' };
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('could not be resolved');
    });
  });
});
