/**
 * Journal Entry Repository Factory
 *
 * Wires domain methods (post, unpost, archive, duplicate, reverse)
 * onto a mongokit Repository. All reads go through repository.getByQuery()
 * so plugins (multi-tenant, audit, cache) fire on every operation.
 *
 * Used by AccountingEngine.wireJournalEntryRepository() and
 * AccountingEngine.createJournalEntryRepository().
 */

import type { Repository, UpdateOptions } from '@classytic/mongokit';
import type { ClientSession, Types } from 'mongoose';
import type { StrictnessConfig } from '../types/engine.js';
// Side-effect import: activates the `_ledgerInternal` typing on
// RepositoryContext/SessionOptions so the calls below are fully type-safe.
import type { LedgerInternalOp } from '../types/mongokit-augmentation.js';
import '../types/mongokit-augmentation.js';
import type { JournalEntryRepository } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

interface PostOptions {
  session?: ClientSession | null;
  /** Actor performing this operation (required when strictness.requireActor is enabled) */
  actorId?: unknown;
}

interface JournalItem {
  account?: unknown;
  debit?: number;
  credit?: number;
}

interface JournalItemWithLabel extends JournalItem {
  label?: string;
  date?: Date;
  taxDetails?: unknown[];
  [key: string]: unknown;
}

/** Keys that are either handled explicitly or must not be copied */
const ITEM_CORE_KEYS = new Set([
  'account',
  'debit',
  'credit',
  'label',
  'date',
  'taxDetails',
  '_id',
  'id',
]);

/** Mongoose document id — string in serialized form, ObjectId at runtime. */
type EntryId = string | Types.ObjectId;

interface JournalEntryDoc {
  _id: EntryId;
  state: string;
  stateChangedAt?: Date;
  journalType?: string;
  referenceNumber?: string;
  label?: string;
  date?: Date;
  reversed?: boolean;
  reversedBy?: unknown;
  reversalOf?: unknown;
  journalItems: JournalItemWithLabel[];
  save(options?: { session?: ClientSession | null }): Promise<this>;
  [key: string]: unknown;
}

/**
 * UpdateOptions extension carrying an internal repo signal that legitimate
 * state-transition methods (post, unpost, archive) use to opt out of the
 * double-entry plugin's immutability guard. Plain `repository.update()`
 * callers cannot set this flag, so the immutability contract is preserved
 * for them.
 */
interface InternalUpdateOptions extends UpdateOptions {
  _ledgerInternal: LedgerInternalOp;
}

interface ReverseOptions extends PostOptions {
  /** Date for the reversal entry (defaults to now) */
  reversalDate?: Date;
}

/**
 * Wire post/reverse onto an existing mongokit Repository.
 *
 * All reads use `repository.getByQuery()` so registered plugins
 * (multi-tenant, audit, cache) fire on every operation.
 *
 * @param repository - A mongokit Repository instance (already created)
 * @param _JournalEntryModel - (Deprecated) The Mongoose model — no longer used internally; kept for API compat
 * @param orgField - The multi-tenant field name (e.g. 'business')
 * @param strictness - Strictness rules (immutable, requireActor, requireApproval)
 */
export function wireJournalEntryMethods<TDoc = unknown>(
  repository: Repository<TDoc>,
  _JournalEntryModel: unknown,
  orgField?: string,
  strictness?: StrictnessConfig,
): JournalEntryRepository<TDoc> {
  // Bind mongokit Repository methods — retain `this` context when called standalone.
  const getByQuery = repository.getByQuery.bind(repository);
  const create = repository.create.bind(repository);
  const update = repository.update.bind(repository);
  const withTransaction = repository.withTransaction.bind(repository);

  // Top-level fields owned by reverse()/duplicate() — copy everything else from
  // the source entry so consumer-defined extraFields (departmentId, projectId,
  // sourceRef, branch tags, etc.) survive these operations.
  const RESERVED_TOPLEVEL = new Set([
    '_id',
    '__v',
    'id',
    'journalType',
    'state',
    'date',
    'label',
    'journalItems',
    'totalDebit',
    'totalCredit',
    'reversalOf',
    'reversedBy',
    'reversedByUser',
    'reversed',
    'stateChangedAt',
    'createdAt',
    'updatedAt',
    'referenceNumber',
    'idempotencyKey',
    'postedBy',
    'approvedBy',
    'approvedAt',
  ]);

  /** Copy non-reserved top-level fields from `source` onto `target`. */
  function copyExtraTopLevel(
    source: Record<string, unknown>,
    target: Record<string, unknown>,
  ): void {
    const obj =
      typeof (source as { toObject?: () => Record<string, unknown> }).toObject === 'function'
        ? (source as { toObject: () => Record<string, unknown> }).toObject()
        : source;
    for (const key of Object.keys(obj)) {
      if (RESERVED_TOPLEVEL.has(key)) continue;
      if (key in target) continue; // caller already set it
      const value = obj[key];
      if (value === undefined || value === null) continue;
      target[key] = value;
    }
  }

  // ── Shared helpers ──────────────────────────────────────────────────────

  /** Build a tenant-scoped query for a single entry by ID (injection-safe) */
  function buildQuery(id: unknown, orgId?: unknown): Record<string, unknown> {
    // Prevent MongoDB operator injection — reject plain objects with $ keys
    // Allow: strings, numbers, ObjectId instances (have _bsontype or toHexString)
    validateScalarId(id, 'entry ID');
    if (orgId != null) validateScalarId(orgId, 'organization ID');

    const query: Record<string, unknown> = { _id: id };
    if (orgField && orgId != null) query[orgField] = orgId;
    return query;
  }

  /** Reject operator-injected objects like { $ne: null } but allow ObjectIds */
  function validateScalarId(value: unknown, label: string): void {
    if (value == null || typeof value !== 'object') return; // strings, numbers OK
    // ObjectId instances have _bsontype or toHexString — allow them
    const obj = value as Record<string, unknown>;
    if (typeof obj.toHexString === 'function' || obj._bsontype === 'ObjectId') return;
    // Plain objects (potential injection) — check for $ operator keys
    const keys = Object.keys(obj);
    if (keys.some((k) => k.startsWith('$'))) {
      throw Errors.validation(`Invalid ${label} — MongoDB operators are not allowed.`);
    }
  }

  /** Fetch an entry via the repository (fires all hooks) */
  async function findEntry(
    query: Record<string, unknown>,
    options: { session?: ClientSession | null; populate?: string },
  ): Promise<JournalEntryDoc | null> {
    const opts: Record<string, unknown> = { lean: false };
    if (options.populate) opts.populate = options.populate;
    if (options.session) opts.session = options.session;
    return (await getByQuery(query, opts)) as JournalEntryDoc | null;
  }

  // ── post() ──────────────────────────────────────────────────────────────

  /**
   * Post an entry (draft → posted).
   * Validates items, balance, and accounts before changing state.
   */
  repository.post = async (id: unknown, orgId?: unknown, options: PostOptions = {}) => {
    if (strictness?.requireActor && !options.actorId) {
      throw Errors.validation('actorId is required for post operations.');
    }
    requireOrgScope(orgField, orgId);
    const query = buildQuery(id, orgId);

    const entry = await findEntry(query, {
      session: options.session,
      populate: 'journalItems.account',
    });

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }

    // Idempotency: if already posted with same idempotency key, return as-is
    if (entry.idempotencyKey && entry.state === 'posted') {
      return entry;
    }

    if (entry.state !== 'draft') {
      throw Errors.validation('Only draft entries can be posted');
    }

    // Approval requirement — both approvedBy and approvedAt must be set
    if (strictness?.requireApproval) {
      if (!entry.approvedBy || !entry.approvedAt) {
        throw Errors.validation(
          'Entry must be approved before posting. Both approvedBy and approvedAt are required.',
        );
      }
    }

    // Must have >= 2 items
    if (!entry.journalItems || entry.journalItems.length < 2) {
      throw Errors.validation('Journal entry must have at least 2 items to post');
    }

    // Every item must have a valid account reference
    const missing = entry.journalItems.filter((i: JournalItem) => !i.account || i.account === '');
    if (missing.length > 0) {
      throw Errors.validation(`${missing.length} item(s) missing an account`);
    }

    // Verify all populated accounts actually exist (populate returns null for deleted/fake accounts)
    const nullAccounts = entry.journalItems.filter((i: JournalItem) => {
      // After populate, a valid account is an object with _id. A missing account is null or stays as a string ObjectId.
      const acct = i.account;
      if (!acct) return true;
      if (typeof acct === 'string') return true; // populate failed — account doesn't exist
      if (typeof acct === 'object' && !(acct as Record<string, unknown>)._id) return true;
      return false;
    });
    if (nullAccounts.length > 0) {
      throw Errors.validation(
        `${nullAccounts.length} item(s) reference accounts that do not exist. Ensure all accounts are created before posting.`,
      );
    }

    // Verify all populated accounts belong to the same org (multi-tenant integrity)
    if (orgField && orgId != null) {
      const crossTenant = entry.journalItems.filter((i: JournalItem) => {
        const acct = i.account as Record<string, unknown> | null;
        if (!acct || typeof acct !== 'object') return false;
        return String(acct[orgField]) !== String(orgId);
      });
      if (crossTenant.length > 0) {
        throw Errors.validation(
          `${crossTenant.length} item(s) reference accounts from another organization`,
        );
      }
    }

    // Every item must have debit or credit > 0
    const zeroed = entry.journalItems.filter(
      (i: JournalItem) => (i.debit || 0) === 0 && (i.credit || 0) === 0,
    );
    if (zeroed.length > 0) {
      throw Errors.validation(`${zeroed.length} item(s) have both debit and credit as zero`);
    }

    // Each line must be debit OR credit, not both
    const bothSet = entry.journalItems.filter(
      (i: JournalItem) => (i.debit || 0) > 0 && (i.credit || 0) > 0,
    );
    if (bothSet.length > 0) {
      throw Errors.validation(
        `${bothSet.length} item(s) have both debit and credit set — each line must be debit OR credit, not both`,
      );
    }

    // Must be balanced — integer cents, exact comparison
    const totalDebit = entry.journalItems.reduce(
      (s: number, i: JournalItem) => s + (i.debit || 0),
      0,
    );
    const totalCredit = entry.journalItems.reduce(
      (s: number, i: JournalItem) => s + (i.credit || 0),
      0,
    );
    if (totalDebit !== totalCredit) {
      throw Errors.validation(
        `Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
      );
    }

    // Route the state mutation through repository.update() so plugins
    // (fiscalLockPlugin, dateLockPlugin, audit, observability) fire on the
    // draft → posted transition. Direct entry.save() bypasses the plugin
    // pipeline and silently breaks period locks.
    const patch: Record<string, unknown> = {
      state: 'posted',
      stateChangedAt: new Date(),
    };
    if (options.actorId) patch.postedBy = options.actorId;

    const updateOptions: InternalUpdateOptions = {
      _ledgerInternal: 'post',
      ...(options.session ? { session: options.session } : {}),
    };
    const updated = (await update(entry._id, patch, updateOptions)) as JournalEntryDoc | null;

    return updated ?? entry;
  };

  // ── unpost() ────────────────────────────────────────────────────────────

  /**
   * Unpost an entry (posted → draft).
   * Resets state to draft so the entry can be edited and re-posted.
   * Also clears the reversed flag if set, allowing full re-editing.
   */
  repository.unpost = async (id: unknown, orgId?: unknown, options: PostOptions = {}) => {
    if (strictness?.immutable) {
      throw Errors.immutable(
        'Unpost is disabled in strict mode. Use reverse() to correct posted entries.',
      );
    }
    if (strictness?.requireActor && !options.actorId) {
      throw Errors.validation('actorId is required for unpost operations.');
    }
    requireOrgScope(orgField, orgId);
    const query = buildQuery(id, orgId);

    const entry = await findEntry(query, { session: options.session });

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }
    if (entry.state !== 'posted') {
      throw Errors.validation('Only posted entries can be unposted');
    }

    // Prevent unposting a reversed entry — the reversal entry is still posted
    // and references this entry via reversalOf. Unposting would create an
    // inconsistent state where the reversal exists but the original appears unreversed.
    if (entry.reversed) {
      throw Errors.validation(
        'Cannot unpost a reversed entry. The reversal entry is still posted and linked to this entry. ' +
          'Reverse the reversal entry first, or create a new correcting entry instead.',
      );
    }

    const updateOptions: InternalUpdateOptions = {
      _ledgerInternal: 'unpost',
      ...(options.session ? { session: options.session } : {}),
    };
    const updated = (await update(
      entry._id,
      { state: 'draft', stateChangedAt: new Date() },
      updateOptions,
    )) as JournalEntryDoc | null;

    return updated ?? entry;
  };

  // ── archive() ───────────────────────────────────────────────────────────

  /**
   * Archive a draft entry (draft → archived).
   * Used to discard unneeded drafts without deleting them, preserving audit trail.
   * Only draft entries can be archived. Posted entries must be reversed instead.
   */
  repository.archive = async (id: unknown, orgId?: unknown, options: PostOptions = {}) => {
    if (strictness?.requireActor && !options.actorId) {
      throw Errors.validation('actorId is required for archive operations.');
    }
    requireOrgScope(orgField, orgId);
    const query = buildQuery(id, orgId);

    const entry = await findEntry(query, { session: options.session });

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }
    if (entry.state !== 'draft') {
      throw Errors.validation('Only draft entries can be archived');
    }

    const updateOptions: InternalUpdateOptions = {
      _ledgerInternal: 'archive',
      ...(options.session ? { session: options.session } : {}),
    };
    const updated = (await update(
      entry._id,
      { state: 'archived', stateChangedAt: new Date() },
      updateOptions,
    )) as JournalEntryDoc | null;

    return updated ?? entry;
  };

  // ── duplicate() ─────────────────────────────────────────────────────────

  /**
   * Duplicate an entry as a new draft.
   * Copies journal items, journal type, and label. Assigns today's date.
   */
  repository.duplicate = async (id: unknown, orgId?: unknown, options: PostOptions = {}) => {
    requireOrgScope(orgField, orgId);
    const query = buildQuery(id, orgId);

    const entry = await findEntry(query, { session: options.session });

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }

    const duplicateData: Record<string, unknown> = {
      journalType: entry.journalType,
      state: 'draft',
      date: new Date(),
      label: entry.label ? `Copy of ${entry.label}` : 'Duplicated entry',
      journalItems: entry.journalItems.map((item: JournalItemWithLabel) => {
        const accountId =
          typeof item.account === 'object' && item.account !== null
            ? (item.account as Record<string, unknown>)._id
            : item.account;

        // Preserve dimension/extra fields (departmentId, projectId, locationId, etc.)
        const extra: Record<string, unknown> = {};
        for (const key of Object.keys(item)) {
          if (!ITEM_CORE_KEYS.has(key)) extra[key] = item[key];
        }

        return {
          ...extra,
          account: accountId,
          debit: item.debit ?? 0,
          credit: item.credit ?? 0,
          label: item.label,
          date: new Date(),
          taxDetails: item.taxDetails ?? [],
        };
      }),
    };

    // Propagate every consumer-defined top-level field (extraFields,
    // dimensions, sourceRef, branch tags, organizationId, etc.) so the
    // duplicate keeps all the context the original carried.
    copyExtraTopLevel(entry as unknown as Record<string, unknown>, duplicateData);

    const duplicated = await create(
      duplicateData,
      options.session ? { session: options.session } : {},
    );
    return duplicated;
  };

  // ── reverse() ───────────────────────────────────────────────────────────

  /**
   * Reverse a posted entry by creating a mirror entry with flipped debits/credits.
   * Marks the original as reversed and links both entries bidirectionally.
   *
   * Uses repository.withTransaction() for automatic retry on transient failures.
   * Pass an external session to join a caller-managed transaction instead.
   *
   * Routes the reversal through repository.create() so all plugins (fiscal-lock,
   * double-entry) enforce policy on the reversal entry.
   */
  repository.reverse = async (id: unknown, orgId?: unknown, options: ReverseOptions = {}) => {
    if (strictness?.requireActor && !options.actorId) {
      throw Errors.validation('actorId is required for reverse operations.');
    }
    requireOrgScope(orgField, orgId);
    const query = buildQuery(id, orgId);

    const doReverse = async (session?: ClientSession | null) => {
      const entry = await findEntry(query, {
        session,
        populate: 'journalItems.account',
      });

      if (!entry) {
        throw Errors.notFound('Entry not found');
      }
      if (entry.state !== 'posted') {
        throw Errors.validation('Only posted entries can be reversed');
      }
      if (entry.reversed) {
        throw Errors.validation('Entry has already been reversed');
      }

      // Build reversal items — swap debit ↔ credit for each line
      const reversalItems = entry.journalItems.map((item: JournalItemWithLabel) => {
        const accountId =
          typeof item.account === 'object' && item.account !== null
            ? (item.account as Record<string, unknown>)._id
            : item.account;

        // Preserve dimension/extra fields (departmentId, projectId, locationId, etc.)
        const extra: Record<string, unknown> = {};
        for (const key of Object.keys(item)) {
          if (!ITEM_CORE_KEYS.has(key)) extra[key] = item[key];
        }

        return {
          ...extra,
          account: accountId,
          debit: item.credit ?? 0,
          credit: item.debit ?? 0,
          label: item.label ? `Reversal: ${item.label}` : undefined,
          date: item.date,
          taxDetails: item.taxDetails ?? [],
        };
      });

      const totalDebit = reversalItems.reduce((s: number, i: { debit: number }) => s + i.debit, 0);
      const totalCredit = reversalItems.reduce(
        (s: number, i: { credit: number }) => s + i.credit,
        0,
      );

      // Build reversal entry data
      const reversalData: Record<string, unknown> = {
        journalType: entry.journalType ?? 'MISC',
        state: 'posted',
        date: options.reversalDate ?? new Date(),
        label: `Reversal of ${entry.referenceNumber ?? entry._id}`,
        journalItems: reversalItems,
        totalDebit,
        totalCredit,
        reversalOf: entry._id,
        stateChangedAt: new Date(),
      };

      // Propagate every consumer-defined top-level field (extraFields,
      // dimensions, sourceRef, branch tags, organizationId, etc.) so the
      // reversal carries the same scope/context as the original — branch
      // reports, plugin hooks, and audit trails all see the right data.
      copyExtraTopLevel(entry as unknown as Record<string, unknown>, reversalData);

      // Stamp actor on reversal entry
      if (options.actorId) {
        reversalData.postedBy = options.actorId;
      }

      // Create reversal via repository so plugins (fiscal-lock, double-entry) run
      const reversalEntry = (await create(reversalData, session ? { session } : {})) as Record<
        string,
        unknown
      >;

      // Mark original as reversed (bidirectional link). Route through
      // repository.update() with _ledgerInternal: 'reverseMark' so plugins
      // (audit, observability, notifications) see the reversal event. The
      // double-entry immutability guard honours the internal flag so this
      // legitimate mutation is permitted.
      const markPatch: Record<string, unknown> = {
        reversed: true,
        reversedBy: reversalEntry._id,
      };
      if (options.actorId) markPatch.reversedByUser = options.actorId;

      const markOptions: InternalUpdateOptions = {
        _ledgerInternal: 'reverseMark',
        ...(session ? { session } : {}),
      };
      const marked = (await update(entry._id, markPatch, markOptions)) as JournalEntryDoc | null;

      return { original: marked ?? entry, reversal: reversalEntry };
    };

    // External session: caller manages transaction; run directly
    if (options.session) {
      return await doReverse(options.session);
    }

    // No external session: use withTransaction for automatic retry + standalone fallback
    if (withTransaction) {
      return await withTransaction((session) => doReverse(session), { allowFallback: true });
    }

    // Fallback: no transaction support (test mocks, legacy repos)
    return await doReverse();
  };

  // Register methods for discoverability (mongokit 3.4+ registerMethod)
  const methodNames = ['post', 'unpost', 'archive', 'duplicate', 'reverse'] as const;
  if (typeof repository.registerMethod === 'function') {
    for (const name of methodNames) {
      const fn = repository[name] as (...args: unknown[]) => unknown;
      try {
        delete repository[name]; // Clear direct assignment first
        repository.registerMethod(name, fn);
      } catch {
        // Restore if registerMethod fails (prevents orphaned methods)
        repository[name] = fn;
      }
    }
  }

  // Methods are wired dynamically above — safe cast
  return repository as unknown as JournalEntryRepository<TDoc>;
}
