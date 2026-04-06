/**
 * Reconciliation Repository Factory
 *
 * Wires reconcile/unreconcile/getUnreconciled methods onto a repository.
 * Uses repository methods (create, delete) for hook enforcement.
 * Uses JournalEntryModel directly for cross-repo reads (acceptable pattern).
 *
 * Used by AccountingEngine to add reconciliation capabilities.
 */

import type { Repository } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { ReconciliationRepository } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

interface ReconcileInput {
  account: unknown;
  journalEntryIds: unknown[];
  note?: string;
  reconciledBy?: string;
  organizationId?: unknown;
}

interface UnreconcileInput {
  reconciliationId: unknown;
  organizationId?: unknown;
}

interface GetUnreconciledInput {
  accountId: unknown;
  organizationId?: unknown;
  limit?: number;
  skip?: number;
}

interface JournalEntryDoc {
  _id: unknown;
  state: string;
  journalItems: Array<{ account: unknown; debit?: number; credit?: number }>;
  [key: string]: unknown;
}

/**
 * Wire reconciliation methods onto an existing mongokit Repository.
 *
 * - reconcile() uses repository.create() so hooks (multi-tenant, audit) fire
 * - unreconcile() uses repository.delete() so hooks fire
 * - Cross-repo reads (JournalEntryModel) use direct Model access (acceptable)
 */
export function wireReconciliationMethods<TDoc = unknown>(
  repository: Repository<TDoc>,
  _ReconciliationModel: Model<unknown>,
  JournalEntryModel: Model<unknown>,
  orgField?: string,
): ReconciliationRepository<TDoc> {
  // Bind mongokit Repository methods — retain `this` context when called standalone.
  const create = repository.create.bind(repository);
  const deleteById = repository.delete.bind(repository);

  /**
   * Create a reconciliation record linking matched journal entries.
   * Validates that all entries exist, are posted, and belong to the same account/org.
   */
  repository.reconcile = async (input: ReconcileInput) => {
    const { account, journalEntryIds, note, reconciledBy, organizationId } = input;

    requireOrgScope(orgField, organizationId);

    if (!journalEntryIds || journalEntryIds.length === 0) {
      throw Errors.validation('journalEntryIds must contain at least one entry.');
    }

    // Cross-repo read: fetch journal entries (direct Model access is acceptable
    // for cross-repo queries — JournalEntry repo hooks don't apply here)
    const query: Record<string, unknown> = { _id: { $in: journalEntryIds } };
    if (orgField && organizationId != null) query[orgField] = organizationId;

    const entries = (await JournalEntryModel.find(query).lean()) as unknown as JournalEntryDoc[];

    if (entries.length !== journalEntryIds.length) {
      throw Errors.notFound(
        `Expected ${journalEntryIds.length} entries but found ${entries.length}. Some entries do not exist or belong to a different organization.`,
      );
    }

    // All entries must be posted
    const notPosted = entries.filter((e) => e.state !== 'posted');
    if (notPosted.length > 0) {
      throw Errors.validation(
        `${notPosted.length} entry(ies) are not posted. Only posted entries can be reconciled.`,
      );
    }

    // All journal items in these entries that reference the given account
    // must actually reference that account
    const accountStr = String(account);
    for (const entry of entries) {
      const hasAccount = entry.journalItems.some((item) => String(item.account) === accountStr);
      if (!hasAccount) {
        throw Errors.validation(
          `Entry ${entry._id} does not contain any items for account ${account}.`,
        );
      }
    }

    // Compute debit/credit totals from matching items
    let debitTotal = 0;
    let creditTotal = 0;
    for (const entry of entries) {
      for (const item of entry.journalItems) {
        if (String(item.account) === accountStr) {
          debitTotal += item.debit ?? 0;
          creditTotal += item.credit ?? 0;
        }
      }
    }

    const reconciliationData: Record<string, unknown> = {
      account,
      journalEntryIds,
      debitTotal,
      creditTotal,
      difference: debitTotal - creditTotal,
      note,
      reconciledBy,
      reconciledAt: new Date(),
    };

    if (orgField && organizationId != null) {
      reconciliationData[orgField] = organizationId;
    }

    // Route through repository.create() so hooks (audit, multi-tenant) fire
    const record = await create(reconciliationData);
    return record;
  };

  /**
   * Remove a reconciliation record via repository.delete().
   */
  repository.unreconcile = async (input: UnreconcileInput) => {
    const { reconciliationId, organizationId } = input;

    requireOrgScope(orgField, organizationId);

    // Verify the reconciliation record belongs to this org before deleting.
    // Defense-in-depth: even if multi-tenant plugin is registered, we explicitly
    // check ownership to prevent cross-org deletion via ID guessing.
    if (orgField && organizationId != null) {
      const existing = await repository._executeQuery(async (Model) =>
        Model.findOne({ _id: reconciliationId, [orgField]: organizationId })
          .select('_id')
          .lean(),
      );
      if (!existing) {
        throw Errors.notFound('Reconciliation record not found.');
      }
    }

    // Route through repository.delete() so hooks fire
    const result = await deleteById(String(reconciliationId));
    if (!result.success) {
      throw Errors.notFound('Reconciliation record not found.');
    }

    return result;
  };

  /**
   * Find journal entries for an account that are NOT in any reconciliation record.
   * Uses repository.getAll() for reconciliation lookups (hooks fire),
   * and direct JournalEntryModel for cross-repo reads (acceptable).
   */
  repository.getUnreconciled = async (input: GetUnreconciledInput) => {
    const { accountId, organizationId, limit = 100, skip = 0 } = input;

    requireOrgScope(orgField, organizationId);

    // Use repository._executeQuery to find reconciled IDs (hooks fire)
    const reconFilter: Record<string, unknown> = { account: accountId };
    if (orgField && organizationId != null) reconFilter[orgField] = organizationId;

    const reconciliations = (await repository._executeQuery(async (Model) =>
      Model.find(reconFilter).select('journalEntryIds').lean(),
    )) as unknown as Array<{ journalEntryIds: unknown[] }>;

    const reconciledIds = new Set<string>();
    for (const rec of reconciliations) {
      for (const id of rec.journalEntryIds) {
        reconciledIds.add(String(id));
      }
    }

    // Cross-repo read: find posted entries for this account that are not reconciled
    const entryFilter: Record<string, unknown> = {
      state: 'posted',
      'journalItems.account': accountId,
    };
    if (orgField && organizationId != null) entryFilter[orgField] = organizationId;
    if (reconciledIds.size > 0) {
      entryFilter._id = { $nin: Array.from(reconciledIds) };
    }

    const entries = await JournalEntryModel.find(entryFilter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return entries;
  };

  // Register methods for discoverability (mongokit 3.4+)
  if (typeof repository.registerMethod === 'function') {
    for (const name of ['reconcile', 'unreconcile', 'getUnreconciled'] as const) {
      const fn = repository[name] as (...args: unknown[]) => unknown;
      try {
        delete repository[name];
        repository.registerMethod(name, fn);
      } catch {
        repository[name] = fn;
      }
    }
  }

  // Methods are wired dynamically above — safe cast
  return repository as unknown as ReconciliationRepository<TDoc>;
}
