/**
 * Fiscal Year Closing & Reopening
 *
 * Close: zeroes income/expense accounts, transfers net income to retained
 * earnings via a YEAR_END journal entry, marks the period closed.
 *
 * Reopen: validates no later period is closed, deletes the closing entry,
 * marks the period open again with an audit trail.
 *
 * Session management: creates an internal transaction by default.
 * Pass an external session to join a caller-managed transaction instead.
 */

import type { ClientSession, Model } from 'mongoose';
import type { CountryPack } from '../country/index.js';
import { Errors } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { defaultLogger } from '../utils/logger.js';
import { acquireSession, finalizeSession } from '../utils/session.js';
import { requireOrgScope } from '../utils/tenant-guard.js';

export interface FiscalCloseOptions {
  AccountModel: Model<unknown>;
  JournalEntryModel: Model<unknown>;
  FiscalPeriodModel: Model<unknown>;
  country: CountryPack;
  orgField?: string;
  /** The retained earnings account code — where year-end net income is transferred to */
  retainedEarningsAccountCode?: string;
  logger?: Logger;
}

export interface FiscalCloseResult {
  periodId: unknown;
  netIncome: number;
  closingEntryId: unknown | null;
  accountsClosed: number;
  closedAt: Date;
}

export async function closeFiscalPeriod(
  opts: FiscalCloseOptions,
  params: {
    periodId: unknown;
    organizationId?: unknown;
    closedBy?: string;
    session?: ClientSession;
  },
): Promise<FiscalCloseResult> {
  const {
    AccountModel,
    JournalEntryModel,
    FiscalPeriodModel,
    country,
    orgField,
    retainedEarningsAccountCode = country.retainedEarningsAccountCode ?? '3600',
    logger = defaultLogger,
  } = opts;
  const { periodId, organizationId, closedBy } = params;
  requireOrgScope(orgField, organizationId);

  const { session, ownSession } = await acquireSession(AccountModel.db, params.session, logger);
  let success = false;

  try {
    const queryOpts = session ? { session } : {};

    // 1. Fetch and validate the fiscal period (org-scoped)
    const periodQuery: Record<string, unknown> = { _id: periodId };
    if (orgField && organizationId) periodQuery[orgField] = organizationId;
    const period = (await FiscalPeriodModel.findOne(periodQuery, null, queryOpts).lean()) as Record<
      string,
      unknown
    > | null;
    if (!period) throw Errors.notFound('Fiscal period not found');
    if (period.closed) throw Errors.locked('fiscal', 'Fiscal period is already closed');

    const startDate = period.startDate as Date;
    const endDate = period.endDate as Date;

    // 2. Find all income statement accounts for this org
    const accountQuery: Record<string, unknown> = { active: true };
    if (orgField && organizationId) accountQuery[orgField] = organizationId;
    const allAccounts = (await AccountModel.find(accountQuery, null, queryOpts).lean()) as Array<
      Record<string, unknown>
    >;

    const isAccounts: Array<{ id: unknown; code: string; isIncome: boolean }> = [];
    let retainedEarningsId: unknown = null;

    for (const acc of allAccounts) {
      const at = country.getAccountType(acc.accountTypeCode as string);
      if (!at) continue;

      if (acc.accountTypeCode === retainedEarningsAccountCode) {
        retainedEarningsId = acc._id;
      }

      if (at.isGroup || at.isTotal) continue;
      if (at.category.startsWith('Income Statement')) {
        isAccounts.push({
          id: acc._id,
          code: at.code,
          isIncome: at.category === 'Income Statement-Income',
        });
      }
    }

    if (!retainedEarningsId) {
      throw Errors.locked(
        'fiscal',
        `Retained earnings account (code: ${retainedEarningsAccountCode}) not found. ` +
          'Create this account before closing the fiscal period.',
      );
    }

    // 3. Aggregate balances for all IS accounts in the period
    const baseMatch: Record<string, unknown> = {
      state: 'posted',
      date: { $gte: startDate, $lte: endDate },
    };
    if (orgField && organizationId) baseMatch[orgField] = organizationId;

    const isIds = isAccounts.map((a) => a.id);
    const balances =
      isIds.length > 0
        ? ((await JournalEntryModel.aggregate(
            [
              { $match: baseMatch },
              { $unwind: '$journalItems' },
              { $match: { 'journalItems.account': { $in: isIds } } },
              {
                $group: {
                  _id: '$journalItems.account',
                  d: { $sum: '$journalItems.debit' },
                  c: { $sum: '$journalItems.credit' },
                },
              },
            ],
            queryOpts,
          )) as Array<{ _id: unknown; d: number; c: number }>)
        : [];

    // 4. Build closing journal entry items
    const closingItems: Array<{ account: unknown; debit: number; credit: number; label: string }> =
      [];
    let netIncome = 0;

    const balMap = new Map(balances.map((b) => [String(b._id), b]));

    for (const acc of isAccounts) {
      const bal = balMap.get(String(acc.id));
      if (!bal) continue;

      const net = bal.c - bal.d;
      if (net === 0) continue;

      closingItems.push({
        account: acc.id,
        debit: net > 0 ? net : 0,
        credit: net < 0 ? Math.abs(net) : 0,
        label: `Close ${acc.code}`,
      });

      netIncome += net;
    }

    let closingEntryId: unknown = null;

    if (closingItems.length > 0) {
      closingItems.push({
        account: retainedEarningsId,
        debit: netIncome < 0 ? Math.abs(netIncome) : 0,
        credit: netIncome > 0 ? netIncome : 0,
        label: 'Transfer net income to retained earnings',
      });

      const totalDebit = closingItems.reduce((s, i) => s + i.debit, 0);
      const totalCredit = closingItems.reduce((s, i) => s + i.credit, 0);

      const closingEntryData: Record<string, unknown> = {
        journalType: 'YEAR_END',
        state: 'posted',
        date: endDate,
        label: `Fiscal year closing – ${(period.name as string) ?? 'Period'}`,
        journalItems: closingItems,
        totalDebit,
        totalCredit,
      };
      if (orgField && organizationId) closingEntryData[orgField] = organizationId;

      const [closingEntry] = await JournalEntryModel.create([closingEntryData], queryOpts);
      closingEntryId = closingEntry._id;
    }

    // 5. Mark the period as closed (org-scoped)
    const closedAt = new Date();
    await FiscalPeriodModel.findOneAndUpdate(
      periodQuery,
      { closed: true, closedAt, closedBy: closedBy ?? null, closingEntryId },
      queryOpts,
    );

    const result: FiscalCloseResult = {
      periodId,
      netIncome,
      closingEntryId,
      accountsClosed: closingItems.length - (closingItems.length > 0 ? 1 : 0),
      closedAt,
    };

    success = true;
    return result;
  } finally {
    await finalizeSession(session, ownSession, success);
  }
}

// ── Reopen ────────────────────────────────────────────────────────────────

export interface FiscalReopenResult {
  periodId: unknown;
  deletedEntryId: unknown | null;
  reopenedAt: Date;
}

export async function reopenFiscalPeriod(
  opts: Pick<FiscalCloseOptions, 'JournalEntryModel' | 'FiscalPeriodModel'> & {
    orgField?: string;
    logger?: Logger;
    /** Any model on the same connection — used to start sessions */
    AccountModel?: Model<unknown>;
  },
  params: {
    periodId: unknown;
    organizationId?: unknown;
    reopenedBy?: string;
    session?: ClientSession;
  },
): Promise<FiscalReopenResult> {
  const { JournalEntryModel, FiscalPeriodModel, orgField, logger = defaultLogger } = opts;
  const { periodId, organizationId, reopenedBy } = params;
  requireOrgScope(orgField, organizationId);

  // Use any available model's db connection for session creation
  const db = (opts.AccountModel ?? FiscalPeriodModel).db;
  const { session, ownSession } = await acquireSession(db, params.session, logger);
  let success = false;

  try {
    const queryOpts = session ? { session } : {};

    // 1. Fetch and validate the period (org-scoped)
    const periodQuery: Record<string, unknown> = { _id: periodId };
    if (orgField && organizationId) periodQuery[orgField] = organizationId;
    const period = (await FiscalPeriodModel.findOne(periodQuery, null, queryOpts).lean()) as Record<
      string,
      unknown
    > | null;
    if (!period) throw Errors.notFound('Fiscal period not found');
    if (!period.closed) throw Errors.locked('fiscal', 'Fiscal period is not closed');

    // 2. Block if a later period is already closed (prevents cascade corruption)
    const laterQuery: Record<string, unknown> = {
      closed: true,
      startDate: { $gt: period.endDate },
    };
    if (orgField && organizationId) laterQuery[orgField] = organizationId;

    const laterClosed = await FiscalPeriodModel.findOne(laterQuery, null, queryOpts).lean();
    if (laterClosed) {
      throw Errors.locked(
        'fiscal',
        'Cannot reopen: a later fiscal period is already closed. Reopen later periods first.',
      );
    }

    // 3. Delete the closing journal entry (if one was created)
    const closingEntryId = period.closingEntryId ?? null;
    if (closingEntryId) {
      await JournalEntryModel.findByIdAndDelete(closingEntryId, queryOpts);
    }

    // 4. Mark the period as reopened (org-scoped)
    const reopenedAt = new Date();
    await FiscalPeriodModel.findOneAndUpdate(
      periodQuery,
      {
        closed: false,
        closedAt: null,
        closedBy: null,
        closingEntryId: null,
        reopenedAt,
        reopenedBy: reopenedBy ?? null,
      },
      queryOpts,
    );

    const result: FiscalReopenResult = {
      periodId,
      deletedEntryId: closingEntryId,
      reopenedAt,
    };

    success = true;
    return result;
  } finally {
    await finalizeSession(session, ownSession, success);
  }
}
