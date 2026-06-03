/**
 * Account Repository Factory
 *
 * Creates a mongokit Repository with seedAccounts/bulkCreate and
 * posting-account validation baked in.
 * Used by AccountingEngine.createAccountRepository().
 */

import type { Repository, RepositoryContext } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import type { ClientSession, Model } from 'mongoose';
import type { LedgerBridges } from '../bridges/index.js';
import type { CountryPack } from '../country/index.js';
import { LEDGER_EVENTS } from '../events/event-constants.js';
import type { OutboxStore } from '../events/outbox-store.js';
import type { AccountRepository } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { safePublish } from '../utils/safe-publish.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface AccountIntegrations {
  events?: EventTransport;
  bridges?: LedgerBridges;
  outboxStore?: OutboxStore;
  /**
   * JournalEntry model — when provided, the repository blocks hard deletion
   * of accounts that are referenced by any posted journal item. Without
   * this guard, deleting an in-use account orphans every JE that referenced
   * it (silent data corruption — reports and aggregations stop matching
   * those rows). Hosts seeking a rename/reorganize workflow should soft-
   * delete via `active: false` and create a fresh account.
   */
  journalEntryModel?: Model<unknown>;
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
  const journalEntryModel = integrations.journalEntryModel;
  // Validate posting accounts on create and auto-default name from country pack.
  // Both checks live here (not in the Mongoose schema) because schema validators
  // capture country at model-registration time — on a shared connection the first
  // engine's country pack would fire for every subsequent engine's writes.
  repository.on('before:create', async (ctx: RepositoryContext) => {
    const data = ctx.data as Record<string, unknown> | undefined;
    const code = data?.accountTypeCode as string | undefined;

    if (code && !country.isPostingAccount(code)) {
      throw Errors.validation(
        `Cannot create account with type "${code}" — it is a structural group or calculated total, not a posting account.`,
      );
    }

    // Auto-default name from country pack when omitted (was previously done in
    // schema pre('validate') which captured the wrong pack for later engines).
    if (data && !data.name && code) {
      const at = country.getAccountType(code);
      if (at) data.name = at.name ?? code;
    }

    // Pre-check accountNumber uniqueness so users hitting "Add 1111 again" get
    // a clear message ("Account number 1111 already exists. Use a custom
    // accountNumber to create a sub-account.") instead of a raw E11000.
    // The Mongo unique index remains the source of truth — this hook is for
    // UX only; a true race still surfaces as the underlying validation error.
    if (!data) return;
    const accountNumber =
      (data.accountNumber as string | undefined) ?? (code as string | undefined);
    if (!accountNumber) return;
    const filter: Record<string, unknown> = { accountNumber };
    if (orgField) {
      const orgId = data[orgField] ?? (ctx as { organizationId?: unknown }).organizationId;
      if (orgId != null) filter[orgField] = orgId;
    }
    const existing = await repository.getByQuery(filter, {
      throwOnNotFound: false,
      lean: true,
    });
    if (existing) {
      throw Errors.validation(
        `Account number "${accountNumber}" already exists. Provide a custom accountNumber (e.g. "${accountNumber}-NORTH") to create a sub-account.`,
      );
    }
  });

  // Block hard deletion of accounts referenced by any journal item — even
  // a single posted entry orphans it. Hosts that want to retire an account
  // should soft-delete via `active: false`. The check is a single
  // `journalItems.account` index hit; cheap relative to the data-corruption
  // risk it prevents.
  if (journalEntryModel) {
    repository.on('before:delete', async (ctx: RepositoryContext) => {
      const id = ctx.id;
      if (id == null) return;
      const inUse = await journalEntryModel.exists({ 'journalItems.account': id });
      if (inUse) {
        throw Errors.validation(
          `Cannot delete account ${String(id)} — it is referenced by one or more journal entries. Set active: false to retire it instead.`,
        );
      }
    });
  }

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
          // Inherit cash-account semantics from the country pack's
          // AccountType (e.g. GIFI 1000, AU 1010). Without this the seed
          // path writes nothing and the schema default (false) wins, so
          // seeded cash accounts silently fail Bank Reconciliation, the
          // Cash Flow Statement, and the import bank-account selector —
          // the exact divergence `bulkCreate` already avoids via its
          // `resolvedIsCash`. Seed has no caller override, so the pack
          // flag is authoritative.
          isCashAccount: Boolean(at.isCashAccount),
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
      const { accountTypeCode, accountNumber, name, active = true, isCashAccount } = accounts[i];

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
      // `isCashAccount` resolves in this priority:
      //   1. Caller-supplied flag (explicit override — wins always).
      //   2. Country pack's AccountType.isCashAccount (the catalog-level
      //      truth: "GIFI 1000 IS cash"). This makes the country pack
      //      the single owner of cash-account semantics, so consumers
      //      (Cash Flow report, Bank Reconciliation, JE bank/cash
      //      movement panel) can trust the flag without each having to
      //      re-derive "is this code a cash code?".
      //   3. Default false — for non-cash accounts.
      const resolvedIsCash =
        isCashAccount === undefined ? Boolean(at.isCashAccount) : Boolean(isCashAccount);
      validAccounts.push({
        index: i,
        accountTypeCode,
        accountNumber: resolvedNumber,
        name: resolvedName,
        active: Boolean(active),
        isCashAccount: resolvedIsCash,
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

        // Correlate inserted docs back to toCreate by `accountNumber`,
        // not by array index. Two reasons indices are unreliable here:
        //   1. Mongo / Mongoose `insertMany({ ordered: false })` may
        //      preserve the input order, but plugin chains (mongokit's
        //      before:create / after:create) can reorder or drop docs
        //      without throwing — we'd silently read undefined at the
        //      tail.
        //   2. Drivers occasionally return successful subsets when
        //      partial failures didn't bubble as a bulk error (rare,
        //      but observed in BD ledger-bd 0.6 integration tests).
        // accountNumber is the unique key our pre-flight enforces, so
        // a Map<accountNumber, doc> gives a deterministic correlation
        // regardless of return-order or length.
        const insertedByNumber = new Map<string, Record<string, unknown>>();
        for (const doc of inserted as Array<Record<string, unknown>>) {
          const num = doc?.accountNumber as string | undefined;
          if (num) insertedByNumber.set(num, doc);
        }

        for (const item of toCreate) {
          const doc = insertedByNumber.get(item.accountNumber);
          if (doc) {
            results.created.push({
              accountTypeCode: item.accountTypeCode,
              active: item.active,
              isCashAccount: item.isCashAccount,
              _id: doc._id,
            });
          } else {
            // Driver/plugin returned fewer docs than requested without
            // surfacing an error — record as skipped (concurrent-insert
            // semantics) so the summary stays honest. Better than
            // pushing a `created` entry with a missing _id, which would
            // mislead callers reading `results.created.length` as
            // "rows actually inserted".
            results.skipped.push({
              index: item.index,
              accountTypeCode: item.accountTypeCode,
              reason: 'Not returned by createMany (driver edge case)',
            });
          }
        }
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
