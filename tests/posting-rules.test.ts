/**
 * Posting-rules kernel — engine invariants + corpus fidelity.
 *
 * Part 1 exercises every v1 engine feature with minimal synthetic recipes.
 * Part 2 implements THREE REAL contracts from the be-prod requirements
 * corpus (sales transaction, vendor bill, landed cost) as recipes and pins
 * their drafts — proving the model expresses the migration target before
 * the ledger-bd pack is written. Design: docs/posting-rules-design.md.
 */

import { describe, expect, it } from 'vitest';
import { evaluatePostingRecipe } from '../src/posting-rules/evaluate.js';
import { PostingRuleRegistry } from '../src/posting-rules/registry.js';
import { reversalOf } from '../src/posting-rules/reversal.js';
import { assertDeterministic, expectRecipe } from '../src/posting-rules/test-kit.js';
import type { PostingRecipe } from '../src/posting-rules/types.js';
import {
  DuplicateRecipeError,
  UnbalancedRecipeError,
  UnknownFoldTargetError,
  UnknownSlotError,
} from '../src/posting-rules/types.js';

// ─── Shared slot map (chart-alias fixture) ─────────────────────────────────

const SLOTS: Record<string, string> = {
  cash: '1111',
  bank: '1113',
  gatewayClearing: '1125',
  mobileMoneyMerchant: '1126',
  ar: '1141',
  merchandise: '1164',
  grIrClearing: '2125',
  ap: '2111',
  vdsPayable: '2136',
  vatOutput: '2132',
  revenue: '4111',
  salesDiscount: '4115',
  carriageInward: '5117',
  customsDuty: '5505',
  importLandedCost: '5116',
};

// ─── Part 1: engine invariants ─────────────────────────────────────────────

interface PairInput {
  id: string;
  amount: number;
}

const simplePair: PostingRecipe<PairInput> = {
  name: 'test.simple-pair',
  journalType: 'GENERAL',
  idempotencyKey: (i) => `pair-${i.id}`,
  label: (i) => `Pair ${i.id}`,
  autoPost: true,
  legs: [
    { id: 'in', account: { slot: 'cash' }, side: 'debit', amount: (i: PairInput) => i.amount, label: () => 'cash in' },
    { id: 'rev', account: { slot: 'revenue' }, side: 'credit', amount: (i: PairInput) => i.amount, label: () => 'revenue' },
  ],
};

describe('posting-rules engine invariants', () => {
  it('simple pair: balanced draft, key, autoPost, explain provenance', () => {
    const draft = expectRecipe(simplePair)
      .withSlots(SLOTS)
      .given({ id: 'a1', amount: 500_00 })
      .toPost([
        { slot: 'cash', debit: 500_00 },
        { slot: 'revenue', credit: 500_00 },
      ]);
    expect(draft.idempotencyKey).toBe('pair-a1');
    expect(draft.autoPost).toBe(true);
    expect(draft.skipped).toBe(false);
    expect(draft.legs[0]?.explain).toMatchObject({
      legId: 'in',
      accountMode: 'slot',
      slot: 'cash',
      resolvedCode: '1111',
      conditionResult: true,
    });
  });

  it('default when-guard drops zero-amount legs; all-dropped → skipped draft', () => {
    const draft = expectRecipe(simplePair).withSlots(SLOTS).given({ id: 'z', amount: 0 }).toSkip();
    expect(draft.skipped).toBe(true);
    expect(draft.totals).toEqual({ debit: 0, credit: 0 });
    expect(draft.idempotencyKey).toBe('pair-z'); // key still present for logging
  });

  it('custom `when` REPLACES the default guard (zero-amount leg can post)', () => {
    const zeroOk: PostingRecipe<PairInput> = {
      ...simplePair,
      name: 'test.zero-ok',
      legs: simplePair.legs.map((l) => ({ ...l, when: () => true })),
    };
    const draft = evaluatePostingRecipe(zeroOk, { id: 'z', amount: 0 }, { slots: (s) => SLOTS[s] });
    expect(draft.legs).toHaveLength(2);
    expect(draft.skipped).toBe(false);
  });

  it('unbalanced recipe throws with leg names and totals', () => {
    const broken: PostingRecipe<PairInput> = {
      ...simplePair,
      name: 'test.broken',
      legs: [
        simplePair.legs[0]!,
        { ...simplePair.legs[1]!, amount: (i: PairInput) => i.amount - 1 },
      ],
    };
    expect(() => evaluatePostingRecipe(broken, { id: 'x', amount: 100 }, { slots: (s) => SLOTS[s] })).toThrow(
      UnbalancedRecipeError,
    );
    try {
      evaluatePostingRecipe(broken, { id: 'x', amount: 100 }, { slots: (s) => SLOTS[s] });
    } catch (err) {
      expect((err as Error).message).toContain('in(debit 100)');
      expect((err as Error).message).toContain('rev(credit 99)');
    }
  });

  it('unknown slot fails loud, naming recipe, leg, and slot', () => {
    expect(() =>
      evaluatePostingRecipe(simplePair, { id: 'x', amount: 100 }, { slots: () => undefined }),
    ).toThrow(UnknownSlotError);
  });

  it('route-mode account resolves via slot map (payment-method table)', () => {
    const METHOD_SLOT: Record<string, string> = { cash: 'cash', bkash: 'mobileMoneyMerchant', card: 'gatewayClearing' };
    interface MethodInput {
      id: string;
      method: string;
      amount: number;
    }
    const routed: PostingRecipe<MethodInput> = {
      name: 'test.routed',
      journalType: 'GENERAL',
      idempotencyKey: (i) => `routed-${i.id}`,
      label: () => 'routed',
      autoPost: true,
      legs: [
        {
          id: 'in',
          account: { route: (i: MethodInput) => METHOD_SLOT[i.method] ?? 'bank' },
          side: 'debit',
          amount: (i: MethodInput) => i.amount,
          label: (i: MethodInput) => `via ${i.method}`,
        },
        { id: 'rev', account: { slot: 'revenue' }, side: 'credit', amount: (i: MethodInput) => i.amount, label: () => 'rev' },
      ],
    };
    expectRecipe(routed).withSlots(SLOTS).given({ id: 'm', method: 'bkash', amount: 7_00 }).toPost([
      { code: '1126', debit: 7_00 },
      { slot: 'revenue', credit: 7_00 },
    ]);
  });

  it('resolve+foldInto: posts separately when resolver returns a code', () => {
    const draft = expectRecipe(taxSplit).withSlots(SLOTS).given({ id: 'p1', total: 115_00, tax: 15_00, regime: 'standard' }).toPost([
      { code: '1164', debit: 100_00 },
      { code: '1150.VAT15.INPUT', debit: 15_00 },
      { slot: 'ap', credit: 115_00 },
    ]);
    expect(draft.legs.find((l) => l.legId === 'inventory')?.explain.folded).toBeUndefined();
  });

  it('resolve+foldInto: null resolver FOLDS the amount into the target leg with provenance', () => {
    const draft = expectRecipe(taxSplit).withSlots(SLOTS).given({ id: 'p2', total: 115_00, tax: 15_00, regime: 'tot' }).toPost([
      { code: '1164', debit: 115_00 }, // inventory absorbed the tax
      { slot: 'ap', credit: 115_00 },
    ]);
    const inv = draft.legs.find((l) => l.legId === 'inventory');
    expect(inv?.explain.folded).toEqual({ fromLegId: 'input-vat', amount: 15_00 });
  });

  it('foldInto naming a missing leg throws precisely', () => {
    const bad: PostingRecipe<PairInput> = {
      ...simplePair,
      name: 'test.bad-fold',
      legs: [
        {
          id: 'x',
          account: { resolve: () => null, foldInto: 'nope' },
          side: 'debit',
          amount: (i: PairInput) => i.amount,
          label: () => 'x',
        },
        ...simplePair.legs,
      ],
    };
    expect(() => evaluatePostingRecipe(bad, { id: 'f', amount: 10 }, { slots: (s) => SLOTS[s] })).toThrow(
      UnknownFoldTargetError,
    );
  });

  it('expand: one physical leg per group item (per-method aggregation)', () => {
    interface DayInput {
      date: string;
      byMethod: Array<{ method: string; amount: number }>;
      total: number;
    }
    const daily: PostingRecipe<DayInput> = {
      name: 'test.daily',
      journalType: 'POS_SALES',
      idempotencyKey: (i) => `daily-${i.date}`,
      label: (i) => `POS ${i.date}`,
      autoPost: true,
      legs: [
        {
          id: 'per-method',
          account: { route: (m: { method: string }) => (m.method === 'cash' ? 'cash' : 'gatewayClearing') },
          side: 'debit',
          amount: (m: { amount: number }) => m.amount,
          label: (m: { method: string }) => `POS ${m.method}`,
          expand: (i: DayInput) => i.byMethod,
        },
        { id: 'rev', account: { slot: 'revenue' }, side: 'credit', amount: (i: DayInput) => i.total, label: () => 'POS sales' },
      ],
    };
    expectRecipe(daily)
      .withSlots(SLOTS)
      .given({ date: '2026-07-17', byMethod: [{ method: 'cash', amount: 60_00 }, { method: 'card', amount: 40_00 }], total: 100_00 })
      .toPost([
        { code: '1111', debit: 60_00 },
        { code: '1125', debit: 40_00 },
        { slot: 'revenue', credit: 100_00 },
      ]);
  });

  it('dual-org: organizationId derived per recipe (transfer legs)', () => {
    const orgScoped: PostingRecipe<{ id: string; amount: number; branch: string }> = {
      ...simplePair,
      name: 'test.org',
      idempotencyKey: (i) => `org-${i.id}`,
      organizationId: (i) => i.branch,
    } as never;
    const draft = evaluatePostingRecipe(orgScoped, { id: 'o', amount: 5, branch: 'BR-2' }, { slots: (s) => SLOTS[s] });
    expect(draft.organizationId).toBe('BR-2');
  });

  it('reversalOf: sides mirror, key suffixes, conditions carry over', () => {
    const rev = reversalOf(simplePair, { keySuffix: '-reverse' });
    const original = evaluatePostingRecipe(simplePair, { id: 'r', amount: 9_00 }, { slots: (s) => SLOTS[s] });
    const reversed = evaluatePostingRecipe(rev, { id: 'r', amount: 9_00 }, { slots: (s) => SLOTS[s] });
    expect(reversed.idempotencyKey).toBe('pair-r-reverse');
    expect(reversed.autoPost).toBe(false); // corrections default to review
    expect(reversed.legs.map((l) => [l.accountCode, l.side, l.amount])).toEqual(
      original.legs.map((l) => [l.accountCode, l.side === 'debit' ? 'credit' : 'debit', l.amount]),
    );
  });

  it('assertDeterministic passes pure recipes and catches impure ones', () => {
    assertDeterministic(simplePair, { id: 'd', amount: 3 }, SLOTS);
    const impure: PostingRecipe<PairInput> = {
      ...simplePair,
      name: 'test.impure',
      metadata: () => ({ at: Math.random() }),
    };
    expect(() => assertDeterministic(impure, { id: 'd', amount: 3 }, SLOTS)).toThrow(/non-deterministic/);
  });

  it('test-kit toPost produces a precise diff on mismatch', () => {
    expect(() =>
      expectRecipe(simplePair).withSlots(SLOTS).given({ id: 'a1', amount: 500_00 }).toPost([
        { slot: 'cash', debit: 400_00 }, // deliberate mismatch
        { slot: 'revenue', credit: 500_00 },
      ]),
    ).toThrow(/MISSING expected leg: 1111 debit 40000[\s\S]*UNEXPECTED leg: .*1111 debit 50000/);
  });
});

describe('posting-rule registry', () => {
  it('register/get/duplicate/override/validate', () => {
    const registry = new PostingRuleRegistry();
    registry.register(simplePair);
    expect(registry.get('test.simple-pair').journalType).toBe('GENERAL');
    expect(() => registry.register(simplePair)).toThrow(DuplicateRecipeError);

    registry.override('test.simple-pair', { ...simplePair, journalType: 'HOST' });
    expect(registry.get('test.simple-pair').journalType).toBe('HOST');
    expect(() => registry.override('nope', simplePair)).toThrow(/Cannot override unknown/);
  });

  it('validate collects ALL missing slots across recipes + pack requiredSlots', () => {
    const registry = new PostingRuleRegistry();
    registry.registerPack([simplePair, taxSplit], { requiredSlots: ['mobileMoneyMerchant', 'ghostSlot'] });
    try {
      registry.validate({ slots: (s) => (s === 'cash' ? '1111' : undefined) });
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('revenue (test.simple-pair#rev)');
      expect(msg).toContain('ap (test.tax-split#payable)');
      expect(msg).toContain('ghostSlot (pack requiredSlots)');
      expect(msg).not.toContain('- cash ('); // provided slot not listed
    }
  });
});

// ─── Part 2: corpus fidelity — three real contracts as recipes ─────────────

// Fixture resolver mirroring the BD regime gate (tax.accounts.ts semantics).
const inputVatAccount = (regime: string): string | null =>
  regime === 'standard' || regime === 'importer' ? '1150.VAT15.INPUT' : null;

interface PurchaseInput {
  id: string;
  total: number;
  tax: number;
  regime: string;
}

const taxSplit: PostingRecipe<PurchaseInput> = {
  name: 'test.tax-split',
  journalType: 'PURCHASES',
  idempotencyKey: (i) => `purchase-${i.id}`,
  label: (i) => `Purchase ${i.id}`,
  autoPost: false,
  legs: [
    {
      id: 'inventory',
      account: { slot: 'merchandise' },
      side: 'debit',
      amount: (i: PurchaseInput) => i.total - i.tax,
      label: () => 'Inventory received (net of VAT)',
    },
    {
      id: 'input-vat',
      account: { resolve: (i: PurchaseInput) => inputVatAccount(i.regime), foldInto: 'inventory' },
      side: 'debit',
      amount: (i: PurchaseInput) => i.tax,
      label: () => 'Input VAT (claimable)',
    },
    { id: 'payable', account: { slot: 'ap' }, side: 'credit', amount: (i: PurchaseInput) => i.total, label: () => 'Supplier payable' },
  ],
};

describe('corpus fidelity — real contracts as recipes', () => {
  it('sales transaction: method routing + promo contra-revenue + conditional VAT (sales.contract.ts)', () => {
    interface SalesInput {
      transactionId: string;
      amount: number;
      tax: number;
      method: string;
      promoDiscount: number;
      source: string;
    }
    const METHOD_SLOT: Record<string, string> = { cash: 'cash', bkash: 'mobileMoneyMerchant', card: 'gatewayClearing', bank_transfer: 'bank' };
    const sales: PostingRecipe<SalesInput> = {
      name: 'commerce.sales.transaction',
      journalType: 'ECOM_SALES',
      idempotencyKey: (i) => `sale-${i.transactionId}`,
      label: (i) => `Sale — ${i.method}`,
      autoPost: true,
      legs: [
        {
          id: 'receipt',
          account: { route: (i: SalesInput) => METHOD_SLOT[i.method] ?? 'bank' },
          side: 'debit',
          amount: (i: SalesInput) => i.amount,
          label: (i: SalesInput) => `${i.source} — ${i.method}`,
        },
        {
          id: 'promo',
          account: { slot: 'salesDiscount' },
          side: 'debit',
          amount: (i: SalesInput) => i.promoDiscount,
          label: () => 'Promo discount',
        },
        {
          id: 'revenue',
          // Gross-up: net-of-VAT revenue plus the promo posted as contra keeps gross sales visible.
          account: { slot: 'revenue' },
          side: 'credit',
          amount: (i: SalesInput) => i.amount - i.tax + i.promoDiscount,
          label: () => 'Sales revenue',
        },
        { id: 'vat', account: { slot: 'vatOutput' }, side: 'credit', amount: (i: SalesInput) => i.tax, label: () => 'VAT collected' },
      ],
    };

    // With promo + VAT
    expectRecipe(sales)
      .withSlots(SLOTS)
      .given({ transactionId: 't1', amount: 115_00, tax: 15_00, method: 'bkash', promoDiscount: 10_00, source: 'web' })
      .toPost([
        { code: '1126', debit: 115_00 },
        { slot: 'salesDiscount', debit: 10_00 },
        { slot: 'revenue', credit: 110_00 },
        { slot: 'vatOutput', credit: 15_00 },
      ]);
    // Tax-free, no promo: conditional legs drop
    expectRecipe(sales)
      .withSlots(SLOTS)
      .given({ transactionId: 't2', amount: 50_00, tax: 0, method: 'cash', promoDiscount: 0, source: 'pos' })
      .toPost([
        { code: '1111', debit: 50_00 },
        { slot: 'revenue', credit: 50_00 },
      ]);
    assertDeterministic(sales, { transactionId: 't1', amount: 115_00, tax: 15_00, method: 'bkash', promoDiscount: 10_00, source: 'web' }, SLOTS);
  });

  it('vendor bill: GR/IR + regime-gated VAT fold + VDS withholding + partner/maturity (vendor-bill.contract.ts)', () => {
    interface BillInput {
      purchaseId: string;
      supplierId: string;
      total: number;
      tax: number;
      regime: string;
      vdsAmount: number;
      dueDate: Date;
    }
    const vendorBill: PostingRecipe<BillInput> = {
      name: 'commerce.vendor-bill',
      journalType: 'PURCHASES',
      idempotencyKey: (i) => `vendor-bill-${i.purchaseId}`,
      label: (i) => `Vendor bill ${i.purchaseId}`,
      autoPost: false,
      legs: [
        {
          id: 'grir',
          account: { slot: 'grIrClearing' },
          side: 'debit',
          amount: (i: BillInput) => i.total - i.tax,
          label: () => 'GR/IR clearing (goods received not invoiced)',
        },
        {
          id: 'input-vat',
          account: { resolve: (i: BillInput) => inputVatAccount(i.regime), foldInto: 'grir' },
          side: 'debit',
          amount: (i: BillInput) => i.tax,
          label: () => 'Input VAT (claimable)',
        },
        {
          id: 'payable',
          account: { slot: 'ap' },
          side: 'credit',
          amount: (i: BillInput) => i.total - i.vdsAmount,
          label: () => 'A/P to supplier (net of VDS withheld)',
          partner: (i: BillInput) => ({ partnerId: i.supplierId, partnerType: 'supplier' as const }),
          maturityDate: (i: BillInput) => i.dueDate,
        },
        {
          id: 'vds',
          account: { slot: 'vdsPayable' },
          side: 'credit',
          amount: (i: BillInput) => i.vdsAmount,
          label: () => 'VDS withheld — remit to NBR',
        },
      ],
    };

    const due = new Date('2026-08-01');
    // Standard regime + VDS: 4 legs, partner + maturity on A/P
    const draft = expectRecipe(vendorBill)
      .withSlots(SLOTS)
      .given({ purchaseId: 'po1', supplierId: 'sup1', total: 115_00, tax: 15_00, regime: 'standard', vdsAmount: 7_50, dueDate: due })
      .toPost([
        { slot: 'grIrClearing', debit: 100_00 },
        { code: '1150.VAT15.INPUT', debit: 15_00 },
        { slot: 'ap', credit: 107_50, partner: { partnerId: 'sup1', partnerType: 'supplier' } },
        { slot: 'vdsPayable', credit: 7_50 },
      ]);
    expect(draft.legs.find((l) => l.legId === 'payable')?.maturityDate).toEqual(due);

    // TOT regime, no VDS: VAT folds into GR/IR, VDS drops — still balanced
    expectRecipe(vendorBill)
      .withSlots(SLOTS)
      .given({ purchaseId: 'po2', supplierId: 'sup1', total: 115_00, tax: 15_00, regime: 'tot', vdsAmount: 0, dueDate: due })
      .toPost([
        { slot: 'grIrClearing', debit: 115_00 },
        { slot: 'ap', credit: 115_00, partner: { partnerId: 'sup1', partnerType: 'supplier' } },
      ]);

    // Reversal derives symmetrically (vendorBillReversalToPosting parity)
    const rev = reversalOf(vendorBill, { keySuffix: '-reverse' });
    expectRecipe(rev)
      .withSlots(SLOTS)
      .given({ purchaseId: 'po1', supplierId: 'sup1', total: 115_00, tax: 15_00, regime: 'standard', vdsAmount: 7_50, dueDate: due })
      .toPost([
        { slot: 'grIrClearing', credit: 100_00 },
        { code: '1150.VAT15.INPUT', credit: 15_00 },
        { slot: 'ap', debit: 107_50, partner: { partnerId: 'sup1', partnerType: 'supplier' } },
        { slot: 'vdsPayable', debit: 7_50 },
      ]);
  });

  it('landed cost: regex clearing routes + per-account grouping + reversal (landed-cost.contract.ts)', () => {
    interface Allocation {
      skuRef: string;
      costLineCode: string;
      allocatedPaisa: number;
    }
    interface LandedInput {
      landedCostId: string;
      allocations: Allocation[];
    }
    const clearingSlotFor = (code: string): string => {
      const c = code.toUpperCase();
      if (/DUTY|CUSTOM|TARIFF/.test(c)) return 'customsDuty';
      if (/FREIGHT|CARRIAGE|TRANSPORT|SHIP|CARTAGE/.test(c)) return 'carriageInward';
      return 'importLandedCost';
    };
    const landedCost: PostingRecipe<LandedInput> = {
      name: 'commerce.landed-cost',
      journalType: 'INVENTORY',
      idempotencyKey: (i) => `landed-cost-${i.landedCostId}`,
      label: () => 'Landed cost capitalized to inventory',
      autoPost: true,
      legs: [
        {
          id: 'inventory',
          account: { slot: 'merchandise' },
          side: 'debit',
          amount: (i: LandedInput) => i.allocations.reduce((s, a) => s + a.allocatedPaisa, 0),
          label: () => 'Landed cost capitalized to inventory',
        },
        {
          id: 'clearing',
          account: { route: (g: { slot: string }) => g.slot },
          side: 'credit',
          amount: (g: { amount: number }) => g.amount,
          label: () => 'Landed cost clearing',
          // Group allocations by resolved clearing slot — one credit per account.
          expand: (i: LandedInput) => {
            const groups = new Map<string, number>();
            for (const a of i.allocations) {
              const slot = clearingSlotFor(a.costLineCode);
              groups.set(slot, (groups.get(slot) ?? 0) + a.allocatedPaisa);
            }
            return [...groups.entries()].map(([slot, amount]) => ({ slot, amount }));
          },
        },
      ],
    };

    const input: LandedInput = {
      landedCostId: 'lc1',
      allocations: [
        { skuRef: 'A', costLineCode: 'FREIGHT', allocatedPaisa: 30_00 },
        { skuRef: 'B', costLineCode: 'SEA-FREIGHT', allocatedPaisa: 20_00 },
        { skuRef: 'A', costLineCode: 'DUTY', allocatedPaisa: 40_00 },
        { skuRef: 'B', costLineCode: 'INSURANCE', allocatedPaisa: 10_00 },
      ],
    };
    expectRecipe(landedCost).withSlots(SLOTS).given(input).toPost([
      { slot: 'merchandise', debit: 100_00 },
      { slot: 'carriageInward', credit: 50_00 }, // FREIGHT + SEA-FREIGHT grouped
      { slot: 'customsDuty', credit: 40_00 },
      { slot: 'importLandedCost', credit: 10_00 },
    ]);

    const rev = reversalOf(landedCost, { keySuffix: '-reversal', autoPost: true });
    expectRecipe(rev).withSlots(SLOTS).given(input).toPost([
      { slot: 'merchandise', credit: 100_00 },
      { slot: 'carriageInward', debit: 50_00 },
      { slot: 'customsDuty', debit: 40_00 },
      { slot: 'importLandedCost', debit: 10_00 },
    ]).idempotencyKey === 'landed-cost-lc1-reversal';
  });
});
