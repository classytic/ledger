/**
 * Journal entry mapper — converts fin-io CanonicalJournalEntry (from QBO,
 * Xero, or IIF) into a ledger JournalEntry. The mapping is almost 1:1 since
 * both shapes already represent paired debit/credit lines.
 */

import type { CanonicalJournalEntry } from '@classytic/fin-io';
import type { Cents } from '../../types/core';
import type { ImportMapper } from '../../types/sync';

export interface JournalEntryMapperConfig {
  /** Map accountCode from the source to a ledger Account ObjectId. */
  resolveAccountCode: (code: string) => unknown;
}

export function journalEntryMapper(
  config: JournalEntryMapperConfig,
): ImportMapper<CanonicalJournalEntry> {
  return {
    externalId: (je) => je.externalId,

    toJournalEntry: (je) => ({
      date: je.date,
      label: je.narration ?? `Imported JE ${je.externalId}`,
      referenceNumber: je.externalId,
      journalItems: je.lines.map((line) => ({
        account: config.resolveAccountCode(line.accountCode),
        debit: (line.debit ? Number(line.debit.amount) : 0) as Cents,
        credit: (line.credit ? Number(line.credit.amount) : 0) as Cents,
        label: line.description,
      })),
      extra: { _importSource: 'journal-entry-import' },
    }),
  };
}
