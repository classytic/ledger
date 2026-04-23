/**
 * Reconciliation Repository Factory (0.6.0 — item-level open-item matching)
 *
 * Implements the three new primitives:
 *
 *   - `match({ account, items, ... })` stamps a shared matchingNumber onto
 *     every referenced item and creates a reconciliation document.
 *     Triggers `after:match` hook for downstream plugins (fxRealization,
 *     cash-basis exigibility).
 *
 *   - `unmatch({ matchingNumber })` clears the matching number from every
 *     referenced item and removes the reconciliation. If an FX realization
 *     entry was booked, it is reversed via journalEntries.reverse.
 *
 *   - `getOpenItems({ accountId })` returns posted journal items against
 *     the account that have no matchingNumber yet. Backed by the sparse
 *     index on `journalItems.matchingNumber`.
 *
 * Matching numbers auto-generate as `RECN-{n}` if the caller doesn't
 * supply one. Uniqueness is enforced by the org-scoped unique index on
 * the reconciliation collection.
 */

import type { Repository, RepositoryInstance } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import type { ClientSession, Model } from 'mongoose';
import type { LedgerBridges } from '../bridges/index.js';
import { LEDGER_EVENTS } from '../events/event-constants.js';
import { createEvent } from '../events/helpers.js';
import type { OutboxStore } from '../events/outbox-store.js';
import type { MatchInput, OpenItem, ReconciliationRepository } from '../types/repositories.js';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface ReconciliationIntegrations {
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

// ─── Hook context types (exported for plugin consumers) ─────────────────────

export interface MatchHookItem {
  entry: unknown;
  itemIndex: number;
  debit: number;
  credit: number;
  amountCurrency: number | null;
  exchangeRate: number | null;
}

/**
 * Context passed to `before:match` and `after:match` hooks.
 *
 * - `before:match`: fired after validation but before the matchingNumber is
 *   stamped and the reconciliation doc is created. Throw to abort.
 * - `after:match`: fired after the reconciliation doc is persisted. Used by
 *   fxRealizationPlugin, and can be used by invoice packages to update
 *   payment state.
 */
export interface MatchHookContext {
  /** The input that was passed to match(). */
  input: MatchInput;
  /** Validated + enriched item snapshots with debit/credit/currency info. */
  items: MatchHookItem[];
  /** Shared currency across all items, or null if mixed. */
  sharedCurrency: string | null;
  /** The matching number (auto-generated or caller-provided). */
  matchingNumber: string;
  /** Totals for the matched set. */
  debitTotal: number;
  creditTotal: number;
  isFullReconcile: boolean;
  /** The created reconciliation document (only in after:match). */
  reconciliation?: unknown;
  session: ClientSession | null;
}

/**
 * Context passed to `before:unmatch` and `after:unmatch` hooks.
 */
export interface UnmatchHookContext {
  matchingNumber: string;
  /** The reconciliation document being removed. */
  reconciliation: Record<string, unknown>;
  /** The items that will be / were unmatched. */
  items: Array<{ entry: unknown; itemIndex: number }>;
  organizationId?: unknown;
  session: ClientSession | null;
}

interface JournalEntryDoc {
  _id: unknown;
  state: string;
  journalItems: Array<{
    account: unknown;
    debit?: number;
    credit?: number;
    matchingNumber?: string | null;
    currency?: string | null;
    exchangeRate?: number | null;
    originalDebit?: number | null;
    originalCredit?: number | null;
  }>;
  [key: string]: unknown;
}

/**
 * Default matching-number generator — atomic counter stored in the
 * reconciliation collection. Uses a dedicated sentinel document keyed
 * `{ matchingNumber: '__counter__', [org]: orgId }` so each org has its
 * own counter, safe under concurrent match calls.
 */
async function nextMatchingNumber(
  ReconciliationModel: Model<unknown>,
  orgField: string | undefined,
  orgId: unknown,
  session: ClientSession | null,
): Promise<string> {
  const counterQuery: Record<string, unknown> = { matchingNumber: '__counter__' };
  if (orgField && orgId != null) counterQuery[orgField] = orgId;

  // We abuse findOneAndUpdate($inc) on a synthetic doc that lives alongside
  // real reconciliations. The unique index covers it because the sentinel
  // string is reserved.
  const counterUpdate: Record<string, unknown> = {
    $inc: { seq: 1 },
    $setOnInsert: {
      account: null,
      items: [
        { entry: null, itemIndex: 0 },
        { entry: null, itemIndex: 1 },
      ],
      debitTotal: 0,
      creditTotal: 0,
    },
  };
  // The schema requires `account`, `items`, `debitTotal`, `creditTotal` —
  // setOnInsert provides placeholders. But the validate on items (≥2)
  // won't run on findOneAndUpdate, so this is safe. We'll never read
  // these fields; they exist purely to satisfy the insert path.
  const result = (await ReconciliationModel.findOneAndUpdate(counterQuery, counterUpdate, {
    new: true,
    upsert: true,
    session,
    strict: false,
  }).lean()) as { seq?: number } | null;

  const seq = result?.seq ?? 1;
  return `RECN-${String(seq).padStart(6, '0')}`;
}

export function wireReconciliationMethods<TDoc = Record<string, unknown>>(
  repository: Repository<TDoc>,
  ReconciliationModel: Model<unknown>,
  JournalEntryModel: Model<unknown>,
  orgField?: string,
  integrations: ReconciliationIntegrations = {},
): ReconciliationRepository<TDoc> {
  const create = repository.create.bind(repository);
  const deleteById = repository.delete.bind(repository);
  const repoInstance = repository as unknown as RepositoryInstance;
  const events = integrations.events;
  const outboxStore = integrations.outboxStore;
  const notification = integrations.bridges?.notification;

  // mongokit 3.5.6+ exposes emitAsync() on RepositoryInstance for custom hooks.
  // Used by match() and unmatch() to fire lifecycle events that plugins
  // (fxRealization, invoice bridge, etc.) can subscribe to.
  const emitHook = repoInstance.emitAsync.bind(repoInstance);

  repository.match = async (input: MatchInput) => {
    const { account, items, note, reconciledBy, organizationId, session = null } = input;
    let { matchingNumber } = input;

    requireOrgScope(orgField, organizationId);

    if (!Array.isArray(items) || items.length < 2) {
      throw Errors.validation('match() requires at least two items');
    }

    // Fetch all referenced entries in one query.
    const entryIds = Array.from(new Set(items.map((i) => String(i.entry))));
    const entryQuery: Record<string, unknown> = { _id: { $in: entryIds } };
    if (orgField && organizationId != null) entryQuery[orgField] = organizationId;

    const entries = (await JournalEntryModel.find(entryQuery)
      .session(session)
      .lean()) as unknown as JournalEntryDoc[];

    if (entries.length !== entryIds.length) {
      throw Errors.notFound(
        `Expected ${entryIds.length} entries but found ${entries.length}. Some do not exist or belong to a different organization.`,
      );
    }

    const entryMap = new Map<string, JournalEntryDoc>();
    for (const e of entries) entryMap.set(String(e._id), e);

    // Validate each item reference + compute totals.
    const accountStr = String(account);
    let debitTotal = 0;
    let creditTotal = 0;
    const currencies = new Set<string>();
    const itemSnapshots: Array<{
      entry: unknown;
      itemIndex: number;
      debit: number;
      credit: number;
      amountCurrency: number | null;
      exchangeRate: number | null;
    }> = [];

    for (const ref of items) {
      const entry = entryMap.get(String(ref.entry));
      if (!entry) {
        throw Errors.notFound(`Entry ${String(ref.entry)} not found in match input`);
      }
      if (entry.state !== 'posted') {
        throw Errors.validation(
          `Entry ${String(entry._id)} is not posted — only posted entries can be matched`,
        );
      }
      const item = entry.journalItems[ref.itemIndex];
      if (!item) {
        throw Errors.validation(`Entry ${String(entry._id)} has no item at index ${ref.itemIndex}`);
      }
      if (String(item.account) !== accountStr) {
        throw Errors.validation(
          `Item ${String(entry._id)}[${ref.itemIndex}] is on a different account than the match`,
        );
      }
      if (item.matchingNumber) {
        throw Errors.conflict(
          `Item ${String(entry._id)}[${ref.itemIndex}] is already matched (${item.matchingNumber})`,
        );
      }

      const debit = item.debit ?? 0;
      const credit = item.credit ?? 0;
      debitTotal += debit;
      creditTotal += credit;
      if (item.currency) currencies.add(item.currency);

      const amountCurrency =
        item.originalDebit != null || item.originalCredit != null
          ? (item.originalDebit ?? 0) - (item.originalCredit ?? 0)
          : null;

      itemSnapshots.push({
        entry: entry._id,
        itemIndex: ref.itemIndex,
        debit,
        credit,
        amountCurrency,
        exchangeRate: item.exchangeRate ?? null,
      });
    }

    const difference = debitTotal - creditTotal;
    const isFullReconcile = difference === 0;
    const sharedCurrency = currencies.size === 1 ? Array.from(currencies)[0] : null;

    if (!matchingNumber) {
      matchingNumber = await nextMatchingNumber(
        ReconciliationModel,
        orgField,
        organizationId,
        session,
      );
    }

    // ── Fire before:match hook — plugins can validate or abort ────────
    const hookCtx: MatchHookContext = {
      input,
      items: itemSnapshots,
      sharedCurrency,
      matchingNumber,
      debitTotal,
      creditTotal,
      isFullReconcile,
      session,
    };

    await emitHook('before:match', hookCtx);

    // Atomic bulkWrite to stamp matchingNumber on every referenced item.
    // Using positional operators keyed by the entry id, because mongoose
    // won't cast `journalItems.${idx}.matchingNumber` cleanly via $set on
    // a nested path with a dynamic index. Instead we use arrayFilters.
    const bulkOps = itemSnapshots.map((snap) => ({
      updateOne: {
        filter: { _id: snap.entry },
        update: {
          $set: {
            [`journalItems.${snap.itemIndex}.matchingNumber`]: matchingNumber,
          },
        },
      },
    }));
    await JournalEntryModel.bulkWrite(bulkOps, { session: session ?? undefined });

    // Create the reconciliation doc via the repository so its hooks fire.
    const reconciliationData: Record<string, unknown> = {
      matchingNumber,
      account,
      items: itemSnapshots.map((s) => ({
        entry: s.entry,
        itemIndex: s.itemIndex,
        debit: s.debit,
        credit: s.credit,
        amountCurrency: s.amountCurrency,
        exchangeRate: s.exchangeRate,
      })),
      debitTotal,
      creditTotal,
      difference,
      isFullReconcile,
      currency: sharedCurrency,
      note,
      reconciledBy,
      reconciledAt: new Date(),
    };
    if (orgField && organizationId != null) {
      reconciliationData[orgField] = organizationId;
    }

    const record = (await create(
      reconciliationData as Parameters<typeof create>[0],
    )) as unknown as TDoc;

    // Fire the after:match hook so plugins (fxRealizationPlugin, invoice) can react.
    await emitHook('after:match', {
      ...hookCtx,
      reconciliation: record,
    });

    await safePublish(
      events,
      outboxStore,
      LEDGER_EVENTS.RECONCILIATION_MATCHED,
      {
        matchingNumber,
        account,
        itemCount: itemSnapshots.length,
        debitTotal,
        creditTotal,
        isFullReconcile,
        currency: sharedCurrency,
        organizationId,
      },
      { organizationId, session },
    );

    // Fire notification bridge for unbalanced matches (FX gain/loss, etc.)
    if (!isFullReconcile && notification?.onReconciliationMismatch) {
      try {
        await notification.onReconciliationMismatch(
          {
            matchingNumber,
            account,
            debitTotal,
            creditTotal,
            difference,
            currency: sharedCurrency,
          },
          { organizationId },
        );
      } catch {
        /* bridge failures must not break matching */
      }
    }

    return record;
  };

  repository.unmatch = async (input: {
    matchingNumber: string;
    organizationId?: unknown;
    session?: ClientSession | null;
  }) => {
    const { matchingNumber, organizationId, session = null } = input;
    requireOrgScope(orgField, organizationId);

    const query: Record<string, unknown> = { matchingNumber };
    if (orgField && organizationId != null) query[orgField] = organizationId;

    const existing = (await ReconciliationModel.findOne(query).session(session).lean()) as Record<
      string,
      unknown
    > | null;
    if (!existing) {
      throw Errors.notFound(`Reconciliation ${matchingNumber} not found`);
    }

    const items = (existing.items ?? []) as Array<{ entry: unknown; itemIndex: number }>;

    // ── Fire before:unmatch hook — plugins can validate or abort ──────
    const unmatchCtx: UnmatchHookContext = {
      matchingNumber,
      reconciliation: existing,
      items,
      organizationId,
      session,
    };
    await emitHook('before:unmatch', unmatchCtx);

    // Clear the matchingNumber stamp on every referenced item.
    const bulkOps = items.map((it) => ({
      updateOne: {
        filter: { _id: it.entry },
        update: {
          $set: { [`journalItems.${it.itemIndex}.matchingNumber`]: null },
        },
      },
    }));
    if (bulkOps.length > 0) {
      await JournalEntryModel.bulkWrite(bulkOps, { session: session ?? undefined });
    }

    // Route through repository.delete so hooks fire.
    const result = await deleteById(String((existing as { _id: unknown })._id));
    if (!result.success) {
      throw Errors.notFound('Failed to delete reconciliation record');
    }

    // ── Fire after:unmatch hook ──────────────────────────────────────
    await emitHook('after:unmatch', unmatchCtx);

    await safePublish(
      events,
      outboxStore,
      LEDGER_EVENTS.RECONCILIATION_UNMATCHED,
      { matchingNumber, itemCount: items.length, organizationId },
      { organizationId, session },
    );

    return result;
  };

  repository.getOpenItems = async (params: {
    accountId: unknown;
    organizationId?: unknown;
    filter?: Record<string, unknown>;
    asOfDate?: Date;
    limit?: number;
    skip?: number;
  }): Promise<OpenItem[]> => {
    const { accountId, organizationId, filter, asOfDate, limit = 100, skip = 0 } = params;
    requireOrgScope(orgField, organizationId);

    const match: Record<string, unknown> = { state: 'posted' };
    if (orgField && organizationId != null) match[orgField] = organizationId;
    if (asOfDate) match.date = { $lte: asOfDate };

    // Unwind journalItems and filter by (account, not matched).
    const pipeline: Array<Record<string, unknown>> = [
      { $match: match },
      {
        $project: {
          _id: 1,
          date: 1,
          referenceNumber: 1,
          journalItems: 1,
        },
      },
      {
        $addFields: {
          journalItems: {
            $map: {
              input: { $range: [0, { $size: '$journalItems' }] },
              as: 'idx',
              in: {
                $mergeObjects: [
                  { $arrayElemAt: ['$journalItems', '$$idx'] },
                  { _itemIndex: '$$idx' },
                ],
              },
            },
          },
        },
      },
      { $unwind: '$journalItems' },
      {
        $match: {
          'journalItems.account': accountId,
          $or: [
            { 'journalItems.matchingNumber': null },
            { 'journalItems.matchingNumber': { $exists: false } },
          ],
          // Caller-supplied dimension filter (partnerId, projectId, etc.)
          // is applied here, after the unwind, so each predicate matches
          // the individual item rather than the entry as a whole.
          ...(filter
            ? Object.fromEntries(Object.entries(filter).map(([k, v]) => [`journalItems.${k}`, v]))
            : {}),
        },
      },
      {
        $project: {
          _id: 0,
          entry: '$_id',
          itemIndex: '$journalItems._itemIndex',
          debit: { $ifNull: ['$journalItems.debit', 0] },
          credit: { $ifNull: ['$journalItems.credit', 0] },
          date: { $ifNull: ['$journalItems.date', '$date'] },
          maturityDate: '$journalItems.maturityDate',
          account: '$journalItems.account',
          currency: '$journalItems.currency',
          exchangeRate: '$journalItems.exchangeRate',
          label: '$journalItems.label',
          referenceNumber: 1,
          // Surface the entire item via $mergeObjects so consumers see
          // any extra dimensions (partnerId, projectId, costCenter…)
          // they declared via `schemaOptions.journalEntry.extraItemFields`.
          item: '$journalItems',
        },
      },
      { $sort: { date: 1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const results = (await JournalEntryModel.aggregate(
      pipeline as unknown as Parameters<typeof JournalEntryModel.aggregate>[0],
    )) as unknown as OpenItem[];
    return results;
  };

  if (typeof repository.registerMethod === 'function') {
    for (const name of ['match', 'unmatch', 'getOpenItems'] as const) {
      const fn = repository[name] as (...args: unknown[]) => unknown;
      try {
        delete repository[name];
        repository.registerMethod(name, fn);
      } catch {
        repository[name] = fn;
      }
    }
  }

  return repository as unknown as ReconciliationRepository<TDoc>;
}
