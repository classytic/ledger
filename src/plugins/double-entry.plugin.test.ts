import { describe, it, expect } from 'vitest';
import { doubleEntryPlugin } from './double-entry.plugin.js';

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

/** Mock AccountModel that returns the given accounts (or echoes requested IDs back) */
function createMockAccountModel(accounts?: Array<{ _id: string; business?: string }>) {
  return {
    find: (query: { _id: { $in: string[] } }) => ({
      select: () => ({
        session: () => ({
          lean: () => Promise.resolve(
            accounts ?? query._id.$in.map((id: string) => ({ _id: id })),
          ),
        }),
      }),
    }),
  };
}

/** A permissive mock that always returns all queried accounts — use for tests that only care about balance logic */
const permissiveAccountModel = createMockAccountModel();

describe('doubleEntryPlugin', () => {
  // ── before:create ──────────────────────────────────────────────────────────

  describe('before:create', () => {
    it('allows balanced posted entries', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin({ AccountModel: permissiveAccountModel as any }).apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'a1', debit: 10000, credit: 0 },
          { account: 'a2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
      expect(data.totalDebit).toBe(10000);
      expect(data.totalCredit).toBe(10000);
    });

    it('rejects unbalanced posted entries', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { debit: 10000, credit: 0 },
          { debit: 0, credit: 5000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow('Double-entry violation');
    });

    it('rejects posted entries with empty journal items', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow('at least 2 journal items required');
    });

    it('rejects posted entries with only 1 journal item', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [{ debit: 10000, credit: 0 }],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow('at least 2 journal items required');
    });

    it('skips validation for draft entries (onlyOnPost = true)', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin({ onlyOnPost: true }).apply(repo);

      const data = {
        state: 'draft',
        journalItems: [
          { debit: 10000, credit: 0 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('validates drafts when onlyOnPost is false', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin({ onlyOnPost: false }).apply(repo);

      const data = {
        state: 'draft',
        journalItems: [
          { debit: 10000, credit: 0 },
          { debit: 0, credit: 5000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow('Double-entry violation');
    });

    it('rejects a 1-cent imbalance', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { debit: 1001, credit: 0 },
          { debit: 0, credit: 1000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow('Double-entry violation');
    });

    it('accepts balanced entries', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin({ AccountModel: permissiveAccountModel as any }).apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'a1', debit: 3333, credit: 0 },
          { account: 'a2', debit: 3333, credit: 0 },
          { account: 'a3', debit: 3334, credit: 0 },
          { account: 'a4', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('rejects a journal item with both debit and credit > 0', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { debit: 10000, credit: 5000 },
          { debit: 0, credit: 5000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow(
        'a line cannot have both debit (10000) and credit (5000) greater than zero',
      );
    });

    it('allows items with debit=0 or credit=0', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin({ AccountModel: permissiveAccountModel as any }).apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'a1', debit: 20000, credit: 0 },
          { account: 'a2', debit: 0, credit: 20000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });
  });

  // ── before:create — account existence + tenant integrity ───────────────────

  describe('before:create (account validation)', () => {
    it('allows posted create when all accounts exist and belong to same org', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org1' },
      ];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'posted',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('rejects posted create when account does not exist', async () => {
      const repo = createMockRepo();
      // Only acc1 exists — acc2 is missing
      const mockAccounts = [{ _id: 'acc1', business: 'org1' }];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'posted',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow(
        '1 item(s) reference non-existent accounts',
      );
    });

    it('rejects posted create when account belongs to different org', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org2' }, // Different org!
      ];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'posted',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow(
        '1 item(s) reference accounts from another organization',
      );
    });

    it('skips account validation for draft creates', async () => {
      const repo = createMockRepo();
      // AccountModel would reject, but plugin should skip for drafts
      doubleEntryPlugin({
        AccountModel: createMockAccountModel([]) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'draft',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });

    it('rejects posted create when AccountModel not provided (fail-closed)', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo); // No AccountModel

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).rejects.toThrow(
        'AccountModel is required to validate posted entries',
      );
    });

    it('skips tenant check when orgField not provided', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org2' }, // Different org, but no orgField check
      ];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        // No orgField — only existence check
      }).apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:create', { data })).resolves.toBeUndefined();
    });
  });

  // ── before:update — partial update bypass prevention ───────────────────────

  describe('before:update (partial update)', () => {
    it('validates items when present in update payload', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { debit: 10000, credit: 0 },
          { debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('throws config error when state=posted, no items, and JournalEntryModel not provided', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo); // No JournalEntryModel!

      const data = { state: 'posted' }; // No journalItems — partial update

      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('JournalEntryModel is required');
    });

    it('fetches persisted items and validates when JournalEntryModel is provided', async () => {
      const repo = createMockRepo();
      const mockModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve({
                journalItems: [
                  { debit: 10000, credit: 0 },
                  { debit: 0, credit: 10000 },
                ],
              }),
            }),
          }),
        }),
      };

      doubleEntryPlugin({ JournalEntryModel: mockModel as any }).apply(repo);

      const data = { state: 'posted' };
      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
      expect(data.totalDebit).toBe(10000);
      expect(data.totalCredit).toBe(10000);
    });

    it('rejects when persisted items are unbalanced', async () => {
      const repo = createMockRepo();
      const mockModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve({
                journalItems: [
                  { debit: 10000, credit: 0 },
                  { debit: 0, credit: 5000 },
                ],
              }),
            }),
          }),
        }),
      };

      doubleEntryPlugin({ JournalEntryModel: mockModel as any }).apply(repo);

      const data = { state: 'posted' };
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('Double-entry violation');
    });

    it('rejects when persisted doc has no journal items', async () => {
      const repo = createMockRepo();
      const mockModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve({ journalItems: [] }),
            }),
          }),
        }),
      };

      doubleEntryPlugin({ JournalEntryModel: mockModel as any }).apply(repo);

      const data = { state: 'posted' };
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('at least 2 journal items required');
    });

    it('rejects when persisted doc has only 1 journal item', async () => {
      const repo = createMockRepo();
      const mockModel = {
        findById: () => ({
          select: () => ({
            session: () => ({
              lean: () => Promise.resolve({
                journalItems: [{ debit: 0, credit: 0 }],
              }),
            }),
          }),
        }),
      };

      doubleEntryPlugin({ JournalEntryModel: mockModel as any }).apply(repo);

      const data = { state: 'posted' };
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('at least 2 journal items required, got 1');
    });

    it('rejects update with empty items in payload', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = { state: 'posted', journalItems: [] };
      await expect(
        repo.emit('before:update', { id: 'abc', data }),
      ).rejects.toThrow('at least 2 journal items required');
    });

    it('throws when context.id is missing on partial post update', async () => {
      const repo = createMockRepo();
      const mockModel = {
        findById: () => ({ select: () => ({ session: () => ({ lean: () => Promise.resolve(null) }) }) }),
      };
      doubleEntryPlugin({ JournalEntryModel: mockModel as any }).apply(repo);

      const data = { state: 'posted' }; // No items, no id
      await expect(
        repo.emit('before:update', { data }), // no id in context
      ).rejects.toThrow('update context is missing "id"');
    });

    it('skips validation when state is not posted', async () => {
      const repo = createMockRepo();
      doubleEntryPlugin().apply(repo);

      const data = { state: 'draft', label: 'updated label' };
      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });
  });

  // ── before:update — account validation on update path ───────────────────────

  describe('before:update (account validation)', () => {
    it('validates accounts when items are in update payload and AccountModel provided', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org1' },
      ];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'posted',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });

    it('rejects update→posted when account belongs to different org', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org2' }, // cross-tenant
      ];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = {
        state: 'posted',
        business: 'org1',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:update', { id: 'abc', data })).rejects.toThrow(
        'accounts from another organization',
      );
    });

    it('rejects update→posted when account does not exist', async () => {
      const repo = createMockRepo();
      // Only acc1 exists
      const mockAccounts = [{ _id: 'acc1' }];
      doubleEntryPlugin({
        AccountModel: createMockAccountModel(mockAccounts) as any,
      }).apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:update', { id: 'abc', data })).rejects.toThrow(
        'non-existent accounts',
      );
    });

    it('validates persisted accounts on partial update (state→posted, no items in payload)', async () => {
      const repo = createMockRepo();
      const mockAccounts = [
        { _id: 'acc1', business: 'org1' },
        { _id: 'acc2', business: 'org2' }, // cross-tenant!
      ];

      const mockJEModel = {
        findById: () => ({
          select: (fields: string) => {
            // Immutability guard check returns state for first call
            if (fields === 'state') {
              return {
                session: () => ({
                  lean: () => Promise.resolve({ state: 'draft' }), // target is a draft being posted
                }),
              };
            }
            // Items fetch
            return {
              session: () => ({
                lean: () => Promise.resolve({
                  business: 'org1',
                  journalItems: [
                    { account: 'acc1', debit: 10000, credit: 0 },
                    { account: 'acc2', debit: 0, credit: 10000 },
                  ],
                }),
              }),
            };
          },
        }),
      };

      doubleEntryPlugin({
        JournalEntryModel: mockJEModel as any,
        AccountModel: createMockAccountModel(mockAccounts) as any,
        orgField: 'business',
      }).apply(repo);

      const data = { state: 'posted' };
      await expect(repo.emit('before:update', { id: 'abc', data })).rejects.toThrow(
        'accounts from another organization',
      );
    });

    it('skips account validation on update when AccountModel not provided', async () => {
      const repo = createMockRepo();
      // No AccountModel — should still pass (only balancing checked)
      doubleEntryPlugin().apply(repo);

      const data = {
        state: 'posted',
        journalItems: [
          { account: 'acc1', debit: 10000, credit: 0 },
          { account: 'acc2', debit: 0, credit: 10000 },
        ],
      };

      await expect(repo.emit('before:update', { id: 'abc', data })).resolves.toBeUndefined();
    });
  });
});
