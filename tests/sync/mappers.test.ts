/**
 * Mapper unit tests — verify the canonical→JournalEntry transformation.
 */

import { describe, expect, it } from 'vitest';

import type { CanonicalInvoice, CanonicalJournalEntry, CanonicalTransaction } from '@classytic/fin-io';
import { bankStatementMapper } from '../../src/sync/mappers/bank-statement';
import { invoiceMapper } from '../../src/sync/mappers/invoice';
import { journalEntryMapper } from '../../src/sync/mappers/journal-entry';
import type { ImportContext } from '../../src/types/sync';

const ctx: ImportContext = {
  organizationId: 'org_1',
  importedAt: new Date(),
};

describe('bankStatementMapper', () => {
  const mapper = bankStatementMapper({
    bankAccountId: 'acc-bank',
    suspenseAccountId: 'acc-suspense',
  });

  it('produces a 2-line JE for an inflow (positive amount)', () => {
    const txn: CanonicalTransaction = {
      externalId: 'ofx-001',
      postedDate: new Date('2024-02-15'),
      amount: { amount: 250000n, currency: 'USD' },
      description: 'ACME CORP PAYROLL',
    };

    const result = mapper.toJournalEntry(txn, ctx);
    expect(result).not.toBeNull();
    const je = result as NonNullable<typeof result>;
    if (Array.isArray(je)) throw new Error('expected single');

    expect(je.date).toEqual(txn.postedDate);
    expect(je.journalItems).toHaveLength(2);
    // Inflow: DR bank, CR suspense
    expect(je.journalItems[0]).toMatchObject({ account: 'acc-bank', debit: 250000, credit: 0 });
    expect(je.journalItems[1]).toMatchObject({ account: 'acc-suspense', debit: 0, credit: 250000 });
  });

  it('flips sides for an outflow (negative amount)', () => {
    const txn: CanonicalTransaction = {
      externalId: 'ofx-002',
      postedDate: new Date('2024-02-16'),
      amount: { amount: -4250n, currency: 'USD' },
      description: 'STARBUCKS',
    };

    const je = mapper.toJournalEntry(txn, ctx) as NonNullable<ReturnType<typeof mapper.toJournalEntry>>;
    if (Array.isArray(je)) throw new Error('expected single');

    // Outflow: DR suspense, CR bank
    expect(je.journalItems[0]).toMatchObject({ account: 'acc-suspense', debit: 4250, credit: 0 });
    expect(je.journalItems[1]).toMatchObject({ account: 'acc-bank', debit: 0, credit: 4250 });
  });

  it('uses categorize callback to override the counter-account', () => {
    const mapper2 = bankStatementMapper({
      bankAccountId: 'acc-bank',
      suspenseAccountId: 'acc-suspense',
      categorize: (txn) =>
        txn.counterparty?.name === 'STARBUCKS' ? 'acc-meals' : undefined,
    });

    const txn: CanonicalTransaction = {
      externalId: 'ofx-003',
      postedDate: new Date('2024-02-17'),
      amount: { amount: -500n, currency: 'USD' },
      description: 'STARBUCKS STORE 123',
      counterparty: { name: 'STARBUCKS' },
    };

    const je = mapper2.toJournalEntry(txn, ctx) as NonNullable<ReturnType<typeof mapper.toJournalEntry>>;
    if (Array.isArray(je)) throw new Error('expected single');

    expect(je.journalItems[0].account).toBe('acc-meals');
  });

  it('returns externalId from the canonical transaction', () => {
    const txn: CanonicalTransaction = {
      externalId: 'my-unique-id',
      postedDate: new Date(),
      amount: { amount: 100n, currency: 'USD' },
      description: 'test',
    };
    expect(mapper.externalId(txn)).toBe('my-unique-id');
  });
});

describe('invoiceMapper', () => {
  const mapper = invoiceMapper({
    receivablesAccountId: 'acc-ar',
    payablesAccountId: 'acc-ap',
    defaultRevenueAccountId: 'acc-revenue',
    defaultExpenseAccountId: 'acc-expense',
    taxLiabilityAccountId: 'acc-tax-liability',
    taxReceivableAccountId: 'acc-tax-receivable',
  });

  it('maps a sales invoice: DR AR, CR Revenue lines, CR Tax', () => {
    const inv: CanonicalInvoice = {
      externalId: 'inv-001',
      type: 'sales',
      issueDate: new Date('2024-02-15'),
      contact: { name: 'Acme Corp' },
      lines: [
        { description: 'Widget A', amount: { amount: 10000n, currency: 'USD' } },
        { description: 'Widget B', amount: { amount: 5000n, currency: 'USD' } },
      ],
      subtotal: { amount: 15000n, currency: 'USD' },
      taxTotal: { amount: 2250n, currency: 'USD' },
      total: { amount: 17250n, currency: 'USD' },
      currency: 'USD',
    };

    const je = mapper.toJournalEntry(inv, ctx) as NonNullable<ReturnType<typeof mapper.toJournalEntry>>;
    if (Array.isArray(je)) throw new Error('expected single');

    // AR line (full total, debit)
    expect(je.journalItems[0]).toMatchObject({
      account: 'acc-ar',
      debit: 17250,
      credit: 0,
    });
    // Revenue lines (credit)
    expect(je.journalItems[1]).toMatchObject({
      account: 'acc-revenue',
      debit: 0,
      credit: 10000,
    });
    expect(je.journalItems[2]).toMatchObject({
      account: 'acc-revenue',
      debit: 0,
      credit: 5000,
    });
    // Tax line (credit)
    expect(je.journalItems[3]).toMatchObject({
      account: 'acc-tax-liability',
      debit: 0,
      credit: 2250,
    });

    // Double-entry check: total debits = total credits
    const totalDebit = je.journalItems.reduce((s, i) => s + i.debit, 0);
    const totalCredit = je.journalItems.reduce((s, i) => s + i.credit, 0);
    expect(totalDebit).toBe(totalCredit);
  });

  it('maps a purchase invoice: DR Expense lines, DR Tax, CR AP', () => {
    const bill: CanonicalInvoice = {
      externalId: 'bill-001',
      type: 'purchase',
      issueDate: new Date('2024-02-10'),
      contact: { name: 'Supplier Ltd' },
      lines: [
        { description: 'Office supplies', amount: { amount: 8950n, currency: 'USD' } },
      ],
      subtotal: { amount: 8950n, currency: 'USD' },
      taxTotal: { amount: 0n, currency: 'USD' },
      total: { amount: 8950n, currency: 'USD' },
      currency: 'USD',
    };

    const je = mapper.toJournalEntry(bill, ctx) as NonNullable<ReturnType<typeof mapper.toJournalEntry>>;
    if (Array.isArray(je)) throw new Error('expected single');

    // AP line (credit)
    expect(je.journalItems[0]).toMatchObject({
      account: 'acc-ap',
      debit: 0,
      credit: 8950,
    });
    // Expense line (debit)
    expect(je.journalItems[1]).toMatchObject({
      account: 'acc-expense',
      debit: 8950,
      credit: 0,
    });
  });
});

describe('journalEntryMapper', () => {
  const mapper = journalEntryMapper({
    resolveAccountCode: (code) => `acc-${code}`,
  });

  it('maps a CanonicalJournalEntry 1:1', () => {
    const je: CanonicalJournalEntry = {
      externalId: 'je-001',
      date: new Date('2024-02-15'),
      narration: 'Month-end accrual',
      lines: [
        { accountCode: '100', debit: { amount: 50000n, currency: 'USD' }, description: 'Cash' },
        { accountCode: '200', credit: { amount: 50000n, currency: 'USD' }, description: 'Revenue' },
      ],
    };

    const result = mapper.toJournalEntry(je, ctx);
    expect(result).not.toBeNull();
    if (!result || Array.isArray(result)) throw new Error('expected single');

    expect(result.journalItems).toHaveLength(2);
    expect(result.journalItems[0]).toMatchObject({
      account: 'acc-100',
      debit: 50000,
      credit: 0,
    });
    expect(result.journalItems[1]).toMatchObject({
      account: 'acc-200',
      debit: 0,
      credit: 50000,
    });
    expect(result.label).toBe('Month-end accrual');
  });
});
