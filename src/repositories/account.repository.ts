/**
 * Account Repository Factory
 *
 * Creates a mongokit Repository with seedAccounts/bulkCreate and
 * posting-account validation baked in.
 * Used by AccountingEngine.createAccountRepository().
 */

import type { Repository, RepositoryContext } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import type { ClientSession } from 'mongoose';
import type { LedgerBridges } from '../bridges/index.js';
import type { CountryPack } from '../country/index.js';
import { LEDGER_EVENTS } from '../events/event-constants.js';
import { createEvent } from '../events/helpers.js';
import type { OutboxStore } from '../events/outbox-store.js';
import type { AccountRepository } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface AccountIntegrations {
  events?: EventTransport;
  bridges?: LedgerBridges;
  outboxStore?: OutboxStore;
}

async function safePublish(
  events: EventTransport | undefined,
  outboxStore: OutboxStore | undefined,
  type: string,
  payload: unknown,
  ctx?: { organizationId?: unknown; session?: ClientSession | null },
): Promise<void> {
  const event = createEvent(type, payload, ctx);
  if (outboxStore) {
    try {
      await outboxStore.save(event, { session: ctx?.session ?? undefined });
    } catch {
      /* outbox failures must not break mutations */
    }
  }
  if (events) {
    try {
      await events.publish(event);
    } catch {
      /* transport failures must not break mutations */
    }
  }
}

interface MongoBulkWriteError extends Error {
  code?: number;
  writeErrors?: unknown[];
  insertedDocs?: Array<Record<string, unknown>>;
  /** mongokit's parseDuplicateKeyError wraps E11000 into an HttpError that
   *  exposes `status: 409` and a `duplicate: { fields, values? }` payload
   *  while DROPPING `code` / `writeErrors` / `insertedDocs`. The dup-key
   *  catch below recognizes both shapes. */
  status?: number;
  duplicate?: { fields?: string[]; values?: Record<string, unknown> };
}

function isDuplicateKeyBulkError(err: unknown): err is MongoBulkWriteError {
  if (!err || typeof err !== 'object') return false;
  const e = err as MongoBulkWriteError;
  if (e.code === 11000) return true;
  if (Array.isArray(e.writeErrors) && e.writeErrors.length > 0) return true;
  // mongokit-wrapped form
  if (e.status === 409 && e.duplicate !== undefined) return true;
  return false;
}

interface SeedOptions {
  session?: ClientSession | null;
}

/**
 * Wire seedAccounts, bulkCreate and posting-account validation
 * onto an existing mongokit Repository.
 *
 * @param repository - A mongokit Repository instance (already created)
 * @param country - The CountryPack for account type lookups
 * @param orgField - The multi-tenant field name (e.g. 'business')
 */
export function wireAccountMethods<TDoc = unknown>(
  repository: Repository<TDoc>,
  country: CountryPack,
  orgField?: string,
  integrations: AccountIntegrations = {},
): AccountRepository<TDoc> {
  const events = integrations.events;
  const outboxStore = integrations.outboxStore;
  // Validate posting accounts on create
  repository.on('before:create', (ctx: RepositoryContext) => {
    const code = ctx.data?.accountTypeCode as string | undefined;
    if (code && !country.isPostingAccount(code)) {
      throw Errors.validation(
        `Cannot create account with type "${code}" — it is a structural group or calculated total, not a posting account.`,
      );
    }
  });

  /**
   * Seed standard posting accounts for an organization.
   */
  repository.seedAccounts = async (orgId: unknown, options: SeedOptions = {}) => {
    requireOrgScope(orgField, orgId);
    const postingTypes = country.getPostingAccountTypes();
    const filter: Record<string, unknown> = {};
    if (orgField && orgId != null) filter[orgField] = orgId;

    const existing = (await repository.findAll(filter, {
      select: { accountNumber: 1 },
      lean: true,
    })) as unknown as Array<{ accountNumber: string }>;
    const existingNumbers = new Set(existing.map((a) => a.accountNumber));

    const toCreate = postingTypes
      .filter((at) => !existingNumbers.has(at.code))
      .map((at) => {
        const doc: Record<string, unknown> = {
          accountTypeCode: at.code,
          accountNumber: at.code,
          name: at.name,
        };
        if (orgField && orgId != null) doc[orgField] = orgId;
        return doc;
      });

    if (toCreate.length === 0) return { created: 0, skipped: existingNumbers.size };

    let result: { created: number; skipped: number };
    try {
      // Route through mongokit's createMany so plugins (before:createMany,
      // after:createMany) fire — enables observability, audit, and custom hooks.
      const inserted = await repository.createMany(toCreate, {
        session: options.session ?? undefined,
        ordered: false,
      });
      result = { created: inserted.length, skipped: existingNumbers.size };
    } catch (err: unknown) {
      const bulkError = err as MongoBulkWriteError;
      if (bulkError.code === 11000 || bulkError.writeErrors) {
        const insertedDocs = bulkError.insertedDocs ?? [];
        result = {
          created: insertedDocs.length,
          skipped: existingNumbers.size + (toCreate.length - insertedDocs.length),
        };
      } else {
        throw err;
      }
    }

    await safePublish(
      events,
      outboxStore,
      LEDGER_EVENTS.ACCOUNT_SEEDED,
      { created: result.created, skipped: result.skipped, organizationId: orgId },
      { organizationId: orgId, session: options.session ?? null },
    );
    return result;
  };

  /**
   * Bulk create accounts with validation and skip-if-exists logic.
   *
   * Uses a single batch query to check existing accounts (instead of N+1),
   * and ordered: false on insertMany to handle concurrent race conditions
   * gracefully (duplicate key errors on individual docs don't abort the batch).
   */
  repository.bulkCreate = async (
    accounts: Array<{
      accountTypeCode?: string;
      accountNumber?: string;
      name?: string;
      active?: boolean;
      isCashAccount?: boolean;
    }>,
    orgId: unknown,
  ) => {
    requireOrgScope(orgField, orgId);
    const results: {
      created: Array<Record<string, unknown>>;
      skipped: Array<Record<string, unknown>>;
      errors: Array<Record<string, unknown>>;
    } = { created: [], skipped: [], errors: [] };

    // Validate all accounts first (no DB calls)
    const validAccounts: Array<{
      index: number;
      accountTypeCode: string;
      accountNumber: string;
      name: string;
      active: boolean;
      isCashAccount: boolean;
    }> = [];

    for (let i = 0; i < accounts.length; i++) {
      const {
        accountTypeCode,
        accountNumber,
        name,
        active = true,
        isCashAccount = false,
      } = accounts[i];

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
          reason: `Not a posting account (${at.isGroup ? 'group' : 'total'})`,
        });
        continue;
      }

      const resolvedNumber = accountNumber ?? accountTypeCode;
      const resolvedName = name ?? at.name ?? accountTypeCode;
      validAccounts.push({
        index: i,
        accountTypeCode,
        accountNumber: resolvedNumber,
        name: resolvedName,
        active: Boolean(active),
        isCashAccount: Boolean(isCashAccount),
      });
    }

    if (validAccounts.length === 0) {
      return {
        summary: {
          total: accounts.length,
          created: 0,
          skipped: results.skipped.length,
          errors: results.errors.length,
        },
        ...results,
      };
    }

    // Single batch query to find all existing accounts by accountNumber for this org
    const numbersToCheck = validAccounts.map((a) => a.accountNumber);
    const existsFilter: Record<string, unknown> = { accountNumber: { $in: numbersToCheck } };
    if (orgField && orgId != null) existsFilter[orgField] = orgId;

    const existingDocs = (await repository.findAll(existsFilter, {
      select: { accountNumber: 1 },
      lean: true,
    })) as Array<Record<string, unknown>>;
    const existingNumbers = new Set(existingDocs.map((d) => d.accountNumber as string));

    // Partition into create vs skip
    const toCreate: Array<{
      index: number;
      accountTypeCode: string;
      accountNumber: string;
      name: string;
      active: boolean;
      isCashAccount: boolean;
    }> = [];
    for (const item of validAccounts) {
      if (existingNumbers.has(item.accountNumber)) {
        results.skipped.push({
          index: item.index,
          accountTypeCode: item.accountTypeCode,
          reason: 'Already exists',
        });
      } else {
        toCreate.push(item);
      }
    }

    if (toCreate.length > 0) {
      const docs = toCreate.map((item) => {
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
        // Route through mongokit's createMany so plugins fire
        const inserted = await repository.createMany(docs, { ordered: false });
        results.created = toCreate.map((item, idx) => ({
          accountTypeCode: item.accountTypeCode,
          active: item.active,
          isCashAccount: item.isCashAccount,
          _id: (inserted[idx] as unknown as Record<string, unknown>)._id,
        }));
      } catch (err: unknown) {
        if (!isDuplicateKeyBulkError(err)) throw err;

        const bulkError = err as MongoBulkWriteError;

        // Raw bulk-error path keeps `insertedDocs`; mongokit wraps E11000
        // into a 409 HttpError that strips it. When unavailable, re-query
        // by target accountNumber so we can still resolve `_id`s for docs
        // that ended up persisted (whether by us or a concurrent caller —
        // both satisfy the contract that the accounts now exist).
        const insertedDocs = bulkError.insertedDocs ?? [];
        const insertedNumbers = new Set(
          insertedDocs.map((d: Record<string, unknown>) => d.accountNumber as string),
        );

        const stillUnknown = toCreate.filter((t) => !insertedNumbers.has(t.accountNumber));
        const concurrentlyPersistedById = new Map<string, unknown>();
        if (stillUnknown.length > 0) {
          const concurrentFilter: Record<string, unknown> = {
            accountNumber: { $in: stillUnknown.map((t) => t.accountNumber) },
          };
          if (orgField && orgId != null) concurrentFilter[orgField] = orgId;
          const persisted = (await repository.findAll(concurrentFilter, {
            select: { _id: 1, accountNumber: 1 },
            lean: true,
          })) as Array<Record<string, unknown>>;
          for (const p of persisted) {
            concurrentlyPersistedById.set(p.accountNumber as string, p._id);
          }
        }

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
          } else if (concurrentlyPersistedById.has(item.accountNumber)) {
            results.skipped.push({
              index: item.index,
              accountTypeCode: item.accountTypeCode,
              reason: 'Already exists (concurrent insert)',
              _id: concurrentlyPersistedById.get(item.accountNumber),
            });
          } else {
            results.skipped.push({
              index: item.index,
              accountTypeCode: item.accountTypeCode,
              reason: 'Already exists (concurrent insert)',
            });
          }
        }
      }
    }

    const summary = {
      total: accounts.length,
      created: results.created.length,
      skipped: results.skipped.length,
      errors: results.errors.length,
    };

    await safePublish(
      events,
      outboxStore,
      LEDGER_EVENTS.ACCOUNT_BULK_CREATED,
      {
        created: summary.created,
        skipped: summary.skipped,
        errors: summary.errors,
        organizationId: orgId,
      },
      { organizationId: orgId },
    );

    return { summary, ...results };
  };

  // Register methods for discoverability (mongokit 3.4+)
  if (typeof repository.registerMethod === 'function') {
    for (const name of ['seedAccounts', 'bulkCreate'] as const) {
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
  return repository as unknown as AccountRepository<TDoc>;
}
