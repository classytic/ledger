import { describe, it, expect } from 'vitest';
import { dateLockPlugin } from '../../src/plugins/date-lock.plugin.js';
import { createMockRepository } from '../helpers/mock-repository.js';

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

describe('dateLockPlugin', () => {
  // ── before:create ──────────────────────────────────────────────────────────

  describe('before:create', () => {
    it('blocks posting entry dated before lock date', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-04-01'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-03-15') };
      await expect(
        repo._emitHook('before:create', { data }),
      ).rejects.toThrow('before lock date 2025-04-01');
    });

    it('allows posting entry dated after lock date', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-01-01'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-06-15') };
      await expect(repo._emitHook('before:create', { data })).resolves.toBeUndefined();
    });

    it('allows posting when lock date is null (no lock)', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => null,
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2020-01-01') };
      await expect(repo._emitHook('before:create', { data })).resolves.toBeUndefined();
    });

    it('allows draft entries regardless of date', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-12-31'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'draft', date: new Date('2020-01-01') };
      await expect(repo._emitHook('before:create', { data })).resolves.toBeUndefined();
    });

    it('error message includes the lock date', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-07-01'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-03-15') };
      await expect(
        repo._emitHook('before:create', { data }),
      ).rejects.toThrow('2025-07-01');
    });
  });

  // ── before:update — partial update date handling ───────────────────────────

  describe('before:update (partial update)', () => {
    it('handles partial update — state change to posted without date in payload', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-04-01'),
        JournalEntryModel: createJEModel({ date: new Date('2025-03-15') }),
      }).apply(repo);

      const data = { state: 'posted' }; // no date in payload
      await expect(
        repo._emitHook('before:update', { id: 'abc', data }),
      ).rejects.toThrow('before lock date 2025-04-01');
    });

    it('allows partial update when persisted date is after lock date', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-01-01'),
        JournalEntryModel: createJEModel({ date: new Date('2025-06-15') }),
      }).apply(repo);

      const data = { state: 'posted' }; // no date in payload
      await expect(repo._emitHook('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('uses date from payload when present on update', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-01-01'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted', date: new Date('2025-06-15') };
      await expect(repo._emitHook('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('throws when context.id is missing on partial post update', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-04-01'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { state: 'posted' }; // no date, no id
      await expect(
        repo._emitHook('before:update', { data }), // no id in context
      ).rejects.toThrow('update context is missing "id"');
    });

    it('skips check for non-posted updates', async () => {
      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async () => new Date('2025-12-31'),
        JournalEntryModel: createJEModel(null),
      }).apply(repo);

      const data = { label: 'updated', state: 'draft' };
      await expect(repo._emitHook('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });
  });

  // ── Session passthrough ────────────────────────────────────────────────────

  describe('session handling', () => {
    it('passes session through to getLockDate and findById', async () => {
      const mockSession = { id: 'session-123' } as any;
      let receivedSession: unknown;
      let findByIdSession: unknown;

      const jeModel = {
        findById: () => ({
          select: () => ({
            session: (s: unknown) => {
              findByIdSession = s;
              return {
                lean: () => Promise.resolve({ date: new Date('2025-06-15') }),
              };
            },
          }),
        }),
      } as any;

      const repo = createMockRepository();
      dateLockPlugin({
        getLockDate: async (_orgId, session) => {
          receivedSession = session;
          return null;
        },
        JournalEntryModel: jeModel,
      }).apply(repo);

      const data = { state: 'posted' }; // no date — triggers findById
      await repo._emitHook('before:update', { id: 'abc', data, session: mockSession });

      expect(receivedSession).toBe(mockSession);
      expect(findByIdSession).toBe(mockSession);
    });
  });
});
