/**
 * Typed payload definitions for ledger domain events.
 */

export interface EntryCreatedPayload {
  entryId: unknown;
  journalType?: string;
  state: string;
  referenceNumber?: string;
  idempotencyKey?: string;
  organizationId?: unknown;
}

export interface EntryPostedPayload {
  entryId: unknown;
  referenceNumber?: string;
  postedBy?: unknown;
  totalDebit: number;
  totalCredit: number;
  organizationId?: unknown;
}

export interface EntryUnpostedPayload {
  entryId: unknown;
  unpostedBy?: unknown;
  organizationId?: unknown;
}

export interface EntryArchivedPayload {
  entryId: unknown;
  archivedBy?: unknown;
  organizationId?: unknown;
}

export interface EntryDuplicatedPayload {
  sourceEntryId: unknown;
  duplicateEntryId: unknown;
  organizationId?: unknown;
}

export interface EntryReversedPayload {
  originalEntryId: unknown;
  reversalEntryId: unknown;
  reversalDate: Date;
  reversedBy?: unknown;
  organizationId?: unknown;
}

export interface AccountSeededPayload {
  created: number;
  skipped: number;
  organizationId?: unknown;
}

export interface AccountBulkCreatedPayload {
  created: number;
  skipped: number;
  errors: number;
  organizationId?: unknown;
}

export interface JournalSeededPayload {
  created: number;
  skipped: number;
  organizationId?: unknown;
}

export interface ReconciliationMatchedPayload {
  matchingNumber: string;
  account: unknown;
  itemCount: number;
  debitTotal: number;
  creditTotal: number;
  isFullReconcile: boolean;
  currency: string | null;
  organizationId?: unknown;
}

export interface ReconciliationUnmatchedPayload {
  matchingNumber: string;
  itemCount: number;
  organizationId?: unknown;
}
