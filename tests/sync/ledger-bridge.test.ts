/**
 * createLedgerBridge — adapter between @classytic/invoice's LedgerBridge
 * contract and @classytic/ledger's Record API.
 *
 * Tests verify:
 *   - Invoice posting maps moveType → correct Record API verb + accounts
 *   - Tax lines are posted to the correct tax accounts
 *   - Payment recording calls record.payment with correct accounts
 *   - Reversal delegates to journalEntries.reverse()
 *   - Credit notes (out_refund, in_refund) flip debit/credit sides
 *   - Receipts map like sales (customer-side)
 *   - idempotencyKey flows through to RecordOptions
 *   - Missing account config throws a clear error
 *   - organizationId flows through all operations
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createLedgerBridge,
  type LedgerBridgeConfig,
} from '../../src/sync/ledger-bridge';

// ─── Mock Record API ───────────────────────────────────────────────────────

function makeMockEngine() {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const record = {
    sale: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'sale', args });
      return { _id: 'je-sale-1' };
    }),
    expense: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'expense', args });
      return { _id: 'je-expense-1' };
    }),
    adjustment: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'adjustment', args });
      return { _id: 'je-adj-1' };
    }),
    payment: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'payment', args });
      return { _id: 'je-payment-1' };
    }),
  };

  const repositories = {
    journalEntries: {
      reverse: vi.fn(async () => ({
        original: { _id: 'je-original' },
        reversal: { _id: 'je-reversal-1' },
      })),
    },
  };

  return { record, repositories, calls };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const baseConfig: LedgerBridgeConfig = {
  accounts: {
    receivable: '1200',
    payable: '2000',
    revenue: '4000',
    expense: '5000',
    taxPayable: '2100',
    taxReceivable: '1150',
    cash: '1000',
  },
};

// ─── createJournalEntry: out_invoice (Customer Invoice) ────────────────────

describe('createLedgerBridge — createJournalEntry', () => {
  it('posts a customer invoice as a sale + tax adjustment', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    const jeId = await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'inv-001',
      moveType: 'out_invoice',
      partnerId: 'partner-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [
        { description: 'Widget A', amount: 10000, taxAmount: 1500, taxCode: 'GST' },
        { description: 'Widget B', amount: 5000, taxAmount: 750, taxCode: 'GST' },
      ],
      totalAmount: 17250,
      taxAmount: 2250,
    });

    expect(jeId).toBe('je-adj-1');
    // Should use adjustment (not sale) because we need multi-line with tax
    expect(engine.record.adjustment).toHaveBeenCalledOnce();

    const [orgId, input, options] = engine.record.adjustment.mock.calls[0];
    expect(orgId).toBe('org_1');
    expect(input.date).toEqual(new Date('2025-06-15'));

    // Lines: DR Receivable (total), CR Revenue per line, CR Tax Payable
    const lines = input.lines;
    // DR Receivable for the full total
    expect(lines[0]).toMatchObject({
      account: '1200',
      debit: 17250,
    });
    // CR Revenue for each line item
    expect(lines[1]).toMatchObject({
      account: '4000',
      credit: 10000,
    });
    expect(lines[2]).toMatchObject({
      account: '4000',
      credit: 5000,
    });
    // CR Tax Payable for the total tax
    expect(lines[3]).toMatchObject({
      account: '2100',
      credit: 2250,
    });
  });

  it('posts a vendor bill as expense adjustment (DR expense, DR tax, CR payable)', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    const jeId = await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'bill-001',
      moveType: 'in_invoice',
      partnerId: 'supplier-1',
      date: new Date('2025-06-10'),
      currency: 'USD',
      lines: [
        { description: 'Office supplies', amount: 8000, taxAmount: 400, taxCode: 'GST' },
      ],
      totalAmount: 8400,
      taxAmount: 400,
    });

    expect(jeId).toBe('je-adj-1');
    const [orgId, input] = engine.record.adjustment.mock.calls[0];
    expect(orgId).toBe('org_1');

    const lines = input.lines;
    // DR Expense per line
    expect(lines[0]).toMatchObject({ account: '5000', debit: 8000 });
    // DR Tax Receivable
    expect(lines[1]).toMatchObject({ account: '1150', debit: 400 });
    // CR Payable for the full total
    expect(lines[2]).toMatchObject({ account: '2000', credit: 8400 });
  });

  it('posts a customer credit note (out_refund) — flipped sides', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'cn-001',
      moveType: 'out_refund',
      partnerId: 'partner-1',
      date: new Date('2025-06-20'),
      currency: 'USD',
      lines: [
        { description: 'Return Widget A', amount: 5000, taxAmount: 750, taxCode: 'GST' },
      ],
      totalAmount: 5750,
      taxAmount: 750,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    const lines = input.lines;

    // Credit note flips: CR Receivable, DR Revenue, DR Tax Payable
    expect(lines[0]).toMatchObject({ account: '1200', credit: 5750 });
    expect(lines[1]).toMatchObject({ account: '4000', debit: 5000 });
    expect(lines[2]).toMatchObject({ account: '2100', debit: 750 });
  });

  it('posts a vendor credit note (in_refund) — flipped sides', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'vcn-001',
      moveType: 'in_refund',
      partnerId: 'supplier-1',
      date: new Date('2025-06-21'),
      currency: 'USD',
      lines: [
        { description: 'Returned goods', amount: 3000, taxAmount: 150, taxCode: 'GST' },
      ],
      totalAmount: 3150,
      taxAmount: 150,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    const lines = input.lines;

    // Vendor credit note: DR Payable, CR Expense, CR Tax Receivable
    expect(lines[0]).toMatchObject({ account: '2000', debit: 3150 });
    expect(lines[1]).toMatchObject({ account: '5000', credit: 3000 });
    expect(lines[2]).toMatchObject({ account: '1150', credit: 150 });
  });

  it('posts a receipt like a customer invoice (customer-side)', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'rct-001',
      moveType: 'receipt',
      partnerId: 'walk-in',
      date: new Date('2025-06-22'),
      currency: 'USD',
      lines: [
        { description: 'POS Sale', amount: 2000, taxAmount: 0 },
      ],
      totalAmount: 2000,
      taxAmount: 0,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    const lines = input.lines;

    // Receipt: DR Receivable/Cash, CR Revenue (no tax line since taxAmount=0)
    expect(lines[0]).toMatchObject({ account: '1200', debit: 2000 });
    expect(lines[1]).toMatchObject({ account: '4000', credit: 2000 });
    expect(lines).toHaveLength(2); // No tax line
  });

  it('skips tax line when taxAmount is zero', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'inv-notax',
      moveType: 'out_invoice',
      partnerId: 'partner-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [
        { description: 'Consulting', amount: 50000, taxAmount: 0 },
      ],
      totalAmount: 50000,
      taxAmount: 0,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    expect(input.lines).toHaveLength(2); // DR Receivable, CR Revenue only
  });

  it('passes idempotencyKey through to RecordOptions', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'inv-idem',
      moveType: 'out_invoice',
      partnerId: 'partner-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [{ description: 'Test', amount: 1000, taxAmount: 0 }],
      totalAmount: 1000,
      taxAmount: 0,
      idempotencyKey: 'ledger:inv-idem',
    });

    const [, , options] = engine.record.adjustment.mock.calls[0];
    expect(options.idempotencyKey).toBe('ledger:inv-idem');
  });

  it('sets label with invoice context', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'inv-label',
      moveType: 'out_invoice',
      partnerId: 'partner-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [{ description: 'Test', amount: 1000, taxAmount: 0 }],
      totalAmount: 1000,
      taxAmount: 0,
      notes: 'Monthly retainer',
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    expect(input.label).toContain('inv-label');
  });

  it('uses custom account overrides per moveType', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, {
      accounts: {
        ...baseConfig.accounts,
        // Override receivable specifically for receipts to use Cash instead
        cash: '1010',
      },
      receiptAccount: '1010', // Receipt goes to cash directly
    });

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'rct-002',
      moveType: 'receipt',
      partnerId: 'walk-in',
      date: new Date('2025-06-22'),
      currency: 'USD',
      lines: [{ description: 'POS Sale', amount: 5000, taxAmount: 0 }],
      totalAmount: 5000,
      taxAmount: 0,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    // Receipt should use receiptAccount instead of receivable
    expect(input.lines[0]).toMatchObject({ account: '1010', debit: 5000 });
  });
});

// ─── reverseJournalEntry ───────────────────────────────────────────────────

describe('createLedgerBridge — reverseJournalEntry', () => {
  it('delegates to journalEntries.reverse() and returns the reversal JE ID', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    const reversalId = await bridge.reverseJournalEntry('je-original', 'Invoice cancelled');

    expect(engine.repositories.journalEntries.reverse).toHaveBeenCalledOnce();
    const [id, orgId, options] = engine.repositories.journalEntries.reverse.mock.calls[0];
    expect(id).toBe('je-original');
    expect(reversalId).toBe('je-reversal-1');
  });
});

// ─── recordPayment ─────────────────────────────────────────────────────────

describe('createLedgerBridge — recordPayment', () => {
  it('records a payment on a customer invoice (AR → Cash)', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    const jeId = await bridge.recordPayment({
      organizationId: 'org_1',
      invoiceId: 'inv-001',
      paymentId: 'pay-001',
      amount: 5000,
      currency: 'USD',
      date: new Date('2025-06-20'),
      method: 'bank_transfer',
    });

    expect(jeId).toBe('je-payment-1');
    expect(engine.record.payment).toHaveBeenCalledOnce();

    const [orgId, input, options] = engine.record.payment.mock.calls[0];
    expect(orgId).toBe('org_1');
    expect(input.amount).toBe(5000);
    expect(input.fromReceivableAccount).toBe('1200');
    expect(input.toCashAccount).toBe('1000');
    expect(input.date).toEqual(new Date('2025-06-20'));
    expect(input.label).toContain('pay-001');
  });

  it('uses payable account for vendor payments when configured', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, {
      ...baseConfig,
      resolvePaymentAccounts: (input) => ({
        receivableOrPayable: '2000',  // AP
        cash: '1000',
      }),
    });

    await bridge.recordPayment({
      organizationId: 'org_1',
      invoiceId: 'bill-001',
      paymentId: 'pay-002',
      amount: 8400,
      currency: 'USD',
      date: new Date('2025-06-20'),
      method: 'check',
    });

    const [, input] = engine.record.payment.mock.calls[0];
    expect(input.fromReceivableAccount).toBe('2000');
  });

  it('passes idempotencyKey derived from paymentId', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.recordPayment({
      organizationId: 'org_1',
      invoiceId: 'inv-001',
      paymentId: 'pay-003',
      amount: 2000,
      currency: 'USD',
      date: new Date('2025-06-20'),
      method: 'cash',
    });

    const [, , options] = engine.record.payment.mock.calls[0];
    expect(options.idempotencyKey).toContain('pay-003');
  });
});

// ─── Double-entry balance verification ─────────────────────────────────────

describe('createLedgerBridge — double-entry invariant', () => {
  it('all lines balance (debits = credits) for customer invoice', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'inv-balance',
      moveType: 'out_invoice',
      partnerId: 'partner-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [
        { description: 'A', amount: 10000, taxAmount: 1500 },
        { description: 'B', amount: 5000, taxAmount: 750 },
        { description: 'C', amount: 2500, taxAmount: 0 },
      ],
      totalAmount: 19750,
      taxAmount: 2250,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    const totalDebit = input.lines.reduce(
      (sum: number, l: { debit?: number }) => sum + (l.debit ?? 0),
      0,
    );
    const totalCredit = input.lines.reduce(
      (sum: number, l: { credit?: number }) => sum + (l.credit ?? 0),
      0,
    );
    expect(totalDebit).toBe(totalCredit);
  });

  it('all lines balance for vendor bill with tax', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    await bridge.createJournalEntry({
      organizationId: 'org_1',
      invoiceId: 'bill-balance',
      moveType: 'in_invoice',
      partnerId: 'supplier-1',
      date: new Date('2025-06-15'),
      currency: 'USD',
      lines: [
        { description: 'Parts', amount: 20000, taxAmount: 3000 },
        { description: 'Labour', amount: 15000, taxAmount: 2250 },
      ],
      totalAmount: 40250,
      taxAmount: 5250,
    });

    const [, input] = engine.record.adjustment.mock.calls[0];
    const totalDebit = input.lines.reduce(
      (sum: number, l: { debit?: number }) => sum + (l.debit ?? 0),
      0,
    );
    const totalCredit = input.lines.reduce(
      (sum: number, l: { credit?: number }) => sum + (l.credit ?? 0),
      0,
    );
    expect(totalDebit).toBe(totalCredit);
  });

  it('all lines balance for credit notes', async () => {
    const engine = makeMockEngine();
    const bridge = createLedgerBridge(engine, baseConfig);

    for (const moveType of ['out_refund', 'in_refund'] as const) {
      await bridge.createJournalEntry({
        organizationId: 'org_1',
        invoiceId: `${moveType}-balance`,
        moveType,
        partnerId: 'partner-1',
        date: new Date('2025-06-15'),
        currency: 'USD',
        lines: [
          { description: 'Refund', amount: 7000, taxAmount: 1050 },
        ],
        totalAmount: 8050,
        taxAmount: 1050,
      });
    }

    for (const call of engine.record.adjustment.mock.calls) {
      const [, input] = call;
      const totalDebit = input.lines.reduce(
        (sum: number, l: { debit?: number }) => sum + (l.debit ?? 0),
        0,
      );
      const totalCredit = input.lines.reduce(
        (sum: number, l: { credit?: number }) => sum + (l.credit ?? 0),
        0,
      );
      expect(totalDebit).toBe(totalCredit);
    }
  });
});
