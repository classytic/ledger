/**
 * Journal Entry Repository Factory
 *
 * Creates a mongokit Repository with post/reverse domain logic baked in.
 * Used by AccountingEngine.createJournalEntryRepository().
 */

import type { Model, ClientSession } from 'mongoose';
import { Errors } from '../utils/errors.js';
import { requireOrgScope } from '../utils/tenant-guard.js';
import { acquireSession, finalizeSession } from '../utils/session.js';

interface PostOptions {
  session?: ClientSession | null;
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
}

interface JournalEntryDoc {
  _id: unknown;
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

interface ReverseOptions extends PostOptions {
  /** Date for the reversal entry (defaults to now) */
  reversalDate?: Date;
}

/**
 * Wire post/reverse onto an existing mongokit Repository.
 *
 * @param repository - A mongokit Repository instance (already created)
 * @param JournalEntryModel - The Mongoose model for journal entries
 * @param orgField - The multi-tenant field name (e.g. 'business')
 */
export function wireJournalEntryMethods(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repository: any,
  JournalEntryModel: Model<unknown>,
  orgField?: string,
): void {
  /**
   * Post an entry (draft → posted).
   * Validates items, balance, and accounts before changing state.
   */
  repository.post = async function (id: unknown, orgId?: unknown, options: PostOptions = {}) {
    requireOrgScope(orgField, orgId);
    const query: Record<string, unknown> = { _id: id };
    if (orgField && orgId != null) query[orgField] = orgId;

    const entry = (await JournalEntryModel.findOne(query)
      .populate('journalItems.account')
      .session(options.session || null)) as JournalEntryDoc | null;

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }
    if (entry.state !== 'draft') {
      throw Errors.validation('Only draft entries can be posted');
    }

    // Must have >= 2 items
    if (!entry.journalItems || entry.journalItems.length < 2) {
      throw Errors.validation('Journal entry must have at least 2 items to post');
    }

    // Every item must have a valid account
    const missing = entry.journalItems.filter((i: JournalItem) => !i.account || i.account === '');
    if (missing.length > 0) {
      throw Errors.validation(`${missing.length} item(s) missing an account`);
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
    const zeroed = entry.journalItems.filter((i: JournalItem) => (i.debit || 0) === 0 && (i.credit || 0) === 0);
    if (zeroed.length > 0) {
      throw Errors.validation(`${zeroed.length} item(s) have both debit and credit as zero`);
    }

    // Each line must be debit OR credit, not both
    const bothSet = entry.journalItems.filter((i: JournalItem) => (i.debit || 0) > 0 && (i.credit || 0) > 0);
    if (bothSet.length > 0) {
      throw Errors.validation(
        `${bothSet.length} item(s) have both debit and credit set — each line must be debit OR credit, not both`,
      );
    }

    // Must be balanced — integer cents, exact comparison
    const totalDebit = entry.journalItems.reduce((s: number, i: JournalItem) => s + (i.debit || 0), 0);
    const totalCredit = entry.journalItems.reduce((s: number, i: JournalItem) => s + (i.credit || 0), 0);
    if (totalDebit !== totalCredit) {
      throw Errors.validation(
        `Entry is not balanced. Debit: ${totalDebit}, Credit: ${totalCredit}`,
      );
    }

    entry.state = 'posted';
    entry.stateChangedAt = new Date();
    await entry.save({ session: options.session });

    return entry;
  };

  /**
   * Unpost an entry (posted → draft).
   * Resets state to draft so the entry can be edited and re-posted.
   * Also clears the reversed flag if set, allowing full re-editing.
   */
  repository.unpost = async function (id: unknown, orgId?: unknown, options: PostOptions = {}) {
    requireOrgScope(orgField, orgId);
    const query: Record<string, unknown> = { _id: id };
    if (orgField && orgId != null) query[orgField] = orgId;

    const entry = (await JournalEntryModel.findOne(query)
      .session(options.session || null)) as JournalEntryDoc | null;

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }
    if (entry.state !== 'posted') {
      throw Errors.validation('Only posted entries can be unposted');
    }

    entry.state = 'draft';
    entry.stateChangedAt = new Date();
    // Clear reversal flags so the entry is fully editable as a draft
    if (entry.reversed) {
      entry.reversed = false;
      entry.reversedBy = undefined;
    }
    await entry.save({ session: options.session });

    return entry;
  };

  /**
   * Duplicate an entry as a new draft.
   * Copies journal items, journal type, and label. Assigns today's date.
   */
  repository.duplicate = async function (id: unknown, orgId?: unknown, options: PostOptions = {}) {
    requireOrgScope(orgField, orgId);
    const query: Record<string, unknown> = { _id: id };
    if (orgField && orgId != null) query[orgField] = orgId;

    const entry = (await JournalEntryModel.findOne(query)
      .session(options.session || null)) as JournalEntryDoc | null;

    if (!entry) {
      throw Errors.notFound('Entry not found');
    }

    const duplicateData: Record<string, unknown> = {
      journalType: entry.journalType,
      state: 'draft',
      date: new Date(),
      label: entry.label ? `Copy of ${entry.label}` : 'Duplicated entry',
      journalItems: entry.journalItems.map((item: JournalItemWithLabel) => {
        const accountId = typeof item.account === 'object' && item.account !== null
          ? (item.account as Record<string, unknown>)._id
          : item.account;
        return {
          account: accountId,
          debit: item.debit ?? 0,
          credit: item.credit ?? 0,
          label: item.label,
          date: new Date(),
          taxDetails: item.taxDetails ?? [],
        };
      }),
    };

    // Carry over org field
    if (orgField && entry[orgField] != null) {
      duplicateData[orgField] = entry[orgField];
    }

    const duplicated = await repository.create(duplicateData, options.session ? { session: options.session } : {});
    return duplicated;
  };

  /**
   * Reverse a posted entry by creating a mirror entry with flipped debits/credits.
   * Marks the original as reversed and links both entries bidirectionally.
   *
   * Atomic: creates an internal transaction by default. Pass an external session
   * to join a caller-managed transaction instead. On standalone MongoDB (no
   * replica set), falls back to non-atomic execution with a warning.
   *
   * Routes the reversal through repository.create() so all plugins (fiscal-lock,
   * double-entry) enforce policy on the reversal entry.
   */
  repository.reverse = async function (id: unknown, orgId?: unknown, options: ReverseOptions = {}) {
    requireOrgScope(orgField, orgId);
    const { session, ownSession } = await acquireSession(
      JournalEntryModel.db,
      options.session,
    );
    let success = false;

    try {
      const query: Record<string, unknown> = { _id: id };
      if (orgField && orgId != null) query[orgField] = orgId;

      const entry = (await JournalEntryModel.findOne(query)
        .populate('journalItems.account')
        .session(session || null)) as JournalEntryDoc | null;

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
        const accountId = typeof item.account === 'object' && item.account !== null
          ? (item.account as Record<string, unknown>)._id
          : item.account;
        return {
          account: accountId,
          debit: item.credit ?? 0,
          credit: item.debit ?? 0,
          label: item.label ? `Reversal: ${item.label}` : undefined,
          date: item.date,
          taxDetails: item.taxDetails ?? [],
        };
      });

      const totalDebit = reversalItems.reduce((s: number, i: { debit: number }) => s + i.debit, 0);
      const totalCredit = reversalItems.reduce((s: number, i: { credit: number }) => s + i.credit, 0);

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

      // Carry over org field
      if (orgField && entry[orgField] != null) {
        reversalData[orgField] = entry[orgField];
      }

      // Create reversal via repository so plugins (fiscal-lock, double-entry) run
      const reversalEntry = await repository.create(
        reversalData,
        session ? { session } : {},
      );

      // Mark original as reversed (bidirectional link)
      entry.reversed = true;
      entry.reversedBy = reversalEntry._id;
      await entry.save({ session });

      success = true;
      return { original: entry, reversal: reversalEntry };
    } finally {
      await finalizeSession(session, ownSession, success);
    }
  };
}
