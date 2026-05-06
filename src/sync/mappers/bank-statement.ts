/**
 * Bank statement mapper — converts fin-io BankTransaction into a
 * two-line JournalEntry (debit Cash / credit Suspense for inflows, reverse
 * for outflows).
 *
 * This is the reference mapper for all bank-statement parsers: OFX, CAMT.053,
 * MT940, CSV, and Plaid. They all produce BankTransaction, so one mapper
 * handles all of them.
 *
 * Example consumer usage:
 *
 *   import { parseOfx } from '@classytic/fin-io/ofx';
 *   import { wireImport, bankStatementMapper } from '@classytic/ledger/sync';
 *
 *   const parsed = parseOfx(buffer);
 *   const importer = wireImport({
 *     source: parsed.data.flatMap(s => s.transactions),
 *     mapper: bankStatementMapper({
 *       bankAccountId: bankAccount._id,
 *       suspenseAccountId: suspenseAccount._id,
 *       categorize: (txn) => knownVendors[txn.counterparty?.name]?.accountId,
 *     }),
 *     journalEntries,
 *     context: { organizationId },
 *   });
 */

import type { BankTransaction } from '@classytic/primitives/bank-transaction';
import type { Cents } from '../../types/core';
import type { ImportMapper, JournalEntryInput } from '../../types/sync';

export interface BankStatementMapperConfig {
  /** ObjectId of the bank/cash account (debit side for inflows, credit side for outflows). */
  bankAccountId: unknown;
  /** ObjectId of the suspense/unclassified account (the other side). */
  suspenseAccountId: unknown;
  /**
   * Optional categorization callback. Given a BankTransaction, return
   * the ObjectId of a more specific counter-account (e.g. rent, utilities,
   * payroll). If returns undefined, suspenseAccountId is used.
   *
   * This is where AI categorization or a rules engine plugs in.
   */
  categorize?: (txn: BankTransaction) => unknown | undefined;
  /** Label prefix for imported entries. Default: 'Import'. */
  labelPrefix?: string;
}

export function bankStatementMapper(
  config: BankStatementMapperConfig,
): ImportMapper<BankTransaction> {
  return {
    externalId: (txn) => txn.externalId,

    toJournalEntry: (txn, _ctx) => {
      const cents = Number(txn.amount.amount) as Cents;
      const absCents = Math.abs(cents) as Cents;
      const isInflow = cents > 0;
      const counterAccount = config.categorize?.(txn) ?? config.suspenseAccountId;

      const label = [config.labelPrefix ?? 'Import', txn.description, txn.counterparty?.name]
        .filter(Boolean)
        .join(' — ');

      const input: JournalEntryInput = {
        date: txn.postedDate,
        label,
        referenceNumber: txn.externalId,
        journalItems: isInflow
          ? [
              { account: config.bankAccountId, debit: absCents, credit: 0 as Cents },
              { account: counterAccount, debit: 0 as Cents, credit: absCents },
            ]
          : [
              { account: counterAccount, debit: absCents, credit: 0 as Cents },
              { account: config.bankAccountId, debit: 0 as Cents, credit: absCents },
            ],
        extra: {
          _importSource: txn.type ?? 'bank-import',
          _importCounterparty: txn.counterparty?.name,
          _importReference: txn.reference,
        },
      };

      return input;
    },
  };
}
