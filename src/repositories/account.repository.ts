/**
 * Account Repository Factory
 *
 * Creates a mongokit Repository with seedAccounts/bulkCreate and
 * posting-account validation baked in.
 * Used by AccountingEngine.createAccountRepository().
 */

import type { Model, ClientSession } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

interface SeedOptions {
  session?: ClientSession | null;
}

/**
 * Wire seedAccounts, bulkCreate and posting-account validation
 * onto an existing mongokit Repository.
 *
 * @param repository - A mongokit Repository instance (already created)
 * @param AccountModel - The Mongoose model for accounts
 * @param country - The CountryPack for account type lookups
 * @param orgField - The multi-tenant field name (e.g. 'business')
 */
export function wireAccountMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository: any,
  AccountModel: Model<unknown>,
  country: CountryPack,
  orgField?: string,
): void {
  // Validate posting accounts on create
  repository.on('before:create', (ctx: Record<string, unknown>) => {
    const data = ctx.data as Record<string, unknown> | undefined;
    const code = data?.accountTypeCode as string | undefined;
    if (code && !country.isPostingAccount(code)) {
      throw Errors.validation(
        `Cannot create account with type "${code}" — it is a structural group or calculated total, not a posting account.`,
      );
    }
  });

  /**
   * Seed standard posting accounts for an organization.
   */
  repository.seedAccounts = async function (orgId: unknown, options: SeedOptions = {}) {
    requireOrgScope(orgField, orgId);
    const postingTypes = country.getPostingAccountTypes();
    const filter: Record<string, unknown> = {};
    if (orgField && orgId != null) filter[orgField] = orgId;

    const existing = await AccountModel.find(filter).select('accountNumber').lean() as unknown as Array<{ accountNumber: string }>;
    const existingNumbers = new Set(existing.map(a => a.accountNumber));

    const toCreate = postingTypes
      .filter(at => !existingNumbers.has(at.code))
      .map(at => {
        const doc: Record<string, unknown> = {
          accountTypeCode: at.code,
          accountNumber: at.code,
          name: at.name,
        };
        if (orgField && orgId != null) doc[orgField] = orgId;
        return doc;
      });

    if (toCreate.length === 0) return { created: 0, skipped: existingNumbers.size };

    try {
      // ordered: false ensures a dup-key on one doc doesn't abort the rest
      // (handles concurrent seed calls hitting the unique accountNumber index)
      const inserted = await AccountModel.insertMany(toCreate, {
        session: options.session ?? undefined,
        ordered: false,
      });
      return { created: inserted.length, skipped: existingNumbers.size };
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bulkError = err as any;
      if (bulkError.code === 11000 || bulkError.writeErrors) {
        // Partial success: some docs inserted, some hit dup-key from concurrent caller
        const insertedDocs = bulkError.insertedDocs ?? [];
        return {
          created: insertedDocs.length,
          skipped: existingNumbers.size + (toCreate.length - insertedDocs.length),
        };
      }
      throw err;
    }
  };

  /**
   * Bulk create accounts with validation and skip-if-exists logic.
   *
   * Uses a single batch query to check existing accounts (instead of N+1),
   * and ordered: false on insertMany to handle concurrent race conditions
   * gracefully (duplicate key errors on individual docs don't abort the batch).
   */
  repository.bulkCreate = async function (
    accounts: Array<{ accountTypeCode?: string; accountNumber?: string; name?: string; active?: boolean; isCashAccount?: boolean }>,
    orgId: unknown,
  ) {
    requireOrgScope(orgField, orgId);
    const results: {
      created: Array<Record<string, unknown>>;
      skipped: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    } = { created: [], skipped: [], errors: [] };

    // Validate all accounts first (no DB calls)
    const validAccounts: Array<{ index: number; accountTypeCode: string; accountNumber: string; name: string; active: boolean; isCashAccount: boolean }> = [];

    for (let i = 0; i < accounts.length; i++) {
      const { accountTypeCode, accountNumber, name, active = true, isCashAccount = false } = accounts[i];

      if (!accountTypeCode) {
        results.errors.push({ index: i, reason: 'accountTypeCode is required' });
        continue;
      }

      const at = country.getAccountType(accountTypeCode);
      if (!at) {
        results.errors.push({ index: i, accountTypeCode, reason: 'Invalid account type code' });
        continue;
      }

      if (!country.isPostingAccount(accountTypeCode)) {
        results.errors.push({
          index: i,
          accountTypeCode,
          reason: `Not a posting account (${(at as unknown as Record<string, unknown>).isGroup ? 'group' : 'total'})`,
        });
        continue;
      }

      const resolvedNumber = accountNumber ?? accountTypeCode;
      const resolvedName = name ?? (at as unknown as Record<string, unknown>).name as string ?? accountTypeCode;
      validAccounts.push({ index: i, accountTypeCode, accountNumber: resolvedNumber, name: resolvedName, active: Boolean(active), isCashAccount: Boolean(isCashAccount) });
    }

    if (validAccounts.length === 0) {
      return {
        summary: { total: accounts.length, created: 0, skipped: results.skipped.length, errors: results.errors.length },
        ...results,
      };
    }

    // Single batch query to find all existing accounts by accountNumber for this org
    const numbersToCheck = validAccounts.map(a => a.accountNumber);
    const existsFilter: Record<string, unknown> = { accountNumber: { $in: numbersToCheck } };
    if (orgField && orgId != null) existsFilter[orgField] = orgId;

    const existingDocs = await AccountModel.find(existsFilter)
      .select('accountNumber')
      .lean() as Array<Record<string, unknown>>;
    const existingNumbers = new Set(existingDocs.map(d => d.accountNumber as string));

    // Partition into create vs skip
    const toCreate: Array<{ index: number; accountTypeCode: string; accountNumber: string; name: string; active: boolean; isCashAccount: boolean }> = [];
    for (const item of validAccounts) {
      if (existingNumbers.has(item.accountNumber)) {
        results.skipped.push({ index: item.index, accountTypeCode: item.accountTypeCode, reason: 'Already exists' });
      } else {
        toCreate.push(item);
      }
    }

    if (toCreate.length > 0) {
      const docs = toCreate.map(item => {
        const doc: Record<string, unknown> = {
          accountTypeCode: item.accountTypeCode,
          accountNumber: item.accountNumber,
          name: item.name,
          active: item.active,
          isCashAccount: item.isCashAccount,
        };
        if (orgField && orgId != null) doc[orgField] = orgId;
        return doc;
      });

      try {
        // ordered: false ensures a dup-key on one doc doesn't abort the rest
        const inserted = await AccountModel.insertMany(docs, { ordered: false });
        results.created = toCreate.map((item, idx) => ({
          accountTypeCode: item.accountTypeCode,
          active: item.active,
          isCashAccount: item.isCashAccount,
          _id: (inserted[idx] as unknown as Record<string, unknown>)._id,
        }));
      } catch (err: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bulkError = err as any;
        if (bulkError.code === 11000 || bulkError.writeErrors) {
          // Partial success: some docs inserted, some hit dup-key from concurrent caller
          const insertedDocs = bulkError.insertedDocs ?? [];
          const insertedNumbers = new Set(
            insertedDocs.map((d: Record<string, unknown>) => d.accountNumber as string),
          );
          for (const item of toCreate) {
            if (insertedNumbers.has(item.accountNumber)) {
              const iDoc = insertedDocs.find(
                (d: Record<string, unknown>) => d.accountNumber === item.accountNumber,
              );
              results.created.push({
                accountTypeCode: item.accountTypeCode,
                active: item.active,
                isCashAccount: item.isCashAccount,
                _id: iDoc?._id,
              });
            } else {
              results.skipped.push({
                index: item.index,
                accountTypeCode: item.accountTypeCode,
                reason: 'Already exists (concurrent insert)',
              });
            }
          }
        } else {
          throw err;
        }
      }
    }

    return {
      summary: {
        total: accounts.length,
        created: results.created.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
      },
      ...results,
    };
  };
}
