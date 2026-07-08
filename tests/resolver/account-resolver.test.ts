/**
 * Account resolver — unit + regression tests.
 *
 * Covers the resolution contract the posting layer relies on:
 *   - rule matching via the primitives condition DSL (eq / in / contains…)
 *   - priority ordering (specific beats general; ties keep declaration order)
 *   - unconditional priced defaults vs purpose defaults vs null
 *   - traceable `reason` + `ruleId` (audit)
 *   - merge/override precedence (deployment rule beats pack rule)
 *   - validation of host-authored rules
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PURPOSE,
  type AccountRule,
  createAccountResolver,
  mergeAccountConfig,
  validateAccountRules,
} from '../../src/resolver/account-resolver.js';

const BASE_RULES: AccountRule[] = [
  {
    id: 'print',
    purpose: 'expense',
    priority: 10,
    when: { field: 'keyword', op: 'in', value: ['printing', 'poster', 'card'] },
    use: '6301',
    label: 'Printing & Stationery',
  },
  {
    id: 'venue',
    purpose: 'expense',
    priority: 10,
    when: { field: 'keyword', op: 'in', value: ['hall', 'venue', 'event'] },
    use: '6803',
    label: 'Entertainment / Hospitality',
  },
  {
    id: 'marketing-cat',
    purpose: 'expense',
    priority: 5,
    when: { field: 'category', op: 'eq', value: 'marketing' },
    use: '6401',
    label: 'Advertisement & Publicity',
  },
];

const CONFIG = { rules: BASE_RULES, defaults: { expense: '5000', revenue: '4111' } };

describe('createAccountResolver — matching', () => {
  const r = createAccountResolver(CONFIG);

  it('matches a keyword rule and returns code + rule id + reason', () => {
    expect(r.resolve('expense', { keyword: 'poster' })).toEqual({
      code: '6301',
      ruleId: 'print',
      reason: 'Printing & Stationery',
    });
  });

  it('matches a different keyword bucket', () => {
    expect(r.resolve('expense', { keyword: 'hall' })?.code).toBe('6803');
  });

  it('falls to the purpose default when nothing matches', () => {
    expect(r.resolve('expense', { keyword: 'misc-unmapped' })).toEqual({
      code: '5000',
      ruleId: null,
      reason: 'default:expense',
    });
  });

  it('returns null when neither a rule nor a default exists', () => {
    expect(r.resolve('cogs', { keyword: 'x' })).toBeNull();
  });

  it('resolves revenue from the default', () => {
    expect(r.resolve('revenue', {})?.code).toBe('4111');
  });
});

describe('createAccountResolver — priority', () => {
  it('a higher-priority rule wins over a lower one that also matches', () => {
    // keyword 'poster' matches `print` (prio 10); category 'marketing' matches
    // `marketing-cat` (prio 5). The higher-priority keyword rule wins.
    const r = createAccountResolver(CONFIG);
    expect(r.resolve('expense', { keyword: 'poster', category: 'marketing' })?.code).toBe('6301');
  });

  it('lower-priority category rule applies when no high-priority rule matches', () => {
    const r = createAccountResolver(CONFIG);
    expect(r.resolve('expense', { keyword: 'unmapped', category: 'marketing' })?.code).toBe('6401');
  });

  it('ties keep declaration order (first declared wins)', () => {
    const r = createAccountResolver({
      rules: [
        { id: 'a', purpose: 'expense', priority: 1, when: { field: 'k', op: 'eq', value: 'x' }, use: 'AAA' },
        { id: 'b', purpose: 'expense', priority: 1, when: { field: 'k', op: 'eq', value: 'x' }, use: 'BBB' },
      ],
    });
    expect(r.resolve('expense', { k: 'x' })?.ruleId).toBe('a');
  });
});

describe('createAccountResolver — composite conditions', () => {
  it('supports all/any/not from the primitives DSL', () => {
    const r = createAccountResolver({
      rules: [
        {
          id: 'imported-asset',
          purpose: 'inventory',
          when: {
            all: [
              { field: 'imported', op: 'eq', value: true },
              { any: [{ field: 'type', op: 'eq', value: 'raw' }, { field: 'type', op: 'eq', value: 'packing' }] },
            ],
          },
          use: '1520',
        },
      ],
    });
    expect(r.resolve('inventory', { imported: true, type: 'raw' })?.code).toBe('1520');
    expect(r.resolve('inventory', { imported: false, type: 'raw' })).toBeNull();
  });

  it('an unconditional rule acts as a priced default (ordered by priority)', () => {
    const r = createAccountResolver({
      rules: [
        { id: 'catchall', purpose: 'expense', priority: -1, use: '5000' },
        { id: 'special', purpose: 'expense', priority: 10, when: { field: 'k', op: 'eq', value: 'x' }, use: '6301' },
      ],
    });
    expect(r.resolve('expense', { k: 'x' })?.code).toBe('6301');
    expect(r.resolve('expense', { k: 'other' })?.code).toBe('5000');
  });
});

describe('mergeAccountConfig — override precedence', () => {
  it('a higher-priority deployment rule beats the base pack rule', () => {
    const base = { rules: BASE_RULES, defaults: { expense: '5000' } };
    const override = {
      rules: [
        {
          id: 'print-override',
          purpose: 'expense',
          priority: 100,
          when: { field: 'keyword', op: 'in', value: ['printing', 'poster'] },
          use: '6310',
          label: 'Custom Print Account',
        },
      ] as AccountRule[],
    };
    const r = createAccountResolver(mergeAccountConfig(base, override));
    expect(r.resolve('expense', { keyword: 'poster' })?.code).toBe('6310');
  });

  it('later defaults override earlier ones', () => {
    const merged = mergeAccountConfig(
      { defaults: { expense: '5000' } },
      { defaults: { expense: '5999' } },
    );
    expect(createAccountResolver(merged).resolve('expense', {})?.code).toBe('5999');
  });
});

describe('validateAccountRules', () => {
  it('accepts well-formed rules', () => {
    expect(() => validateAccountRules(BASE_RULES)).not.toThrow();
  });

  it('rejects a rule missing use', () => {
    expect(() =>
      validateAccountRules([{ id: 'x', purpose: 'expense', use: '' }]),
    ).toThrow(/missing 'use'/);
  });

  it('rejects a rule with an invalid condition operator', () => {
    expect(() =>
      validateAccountRules([
        { id: 'x', purpose: 'expense', use: '6301', when: { field: 'k', op: 'bogus' as never, value: 1 } },
      ]),
    ).toThrow();
  });
});

describe('ACCOUNT_PURPOSE constants', () => {
  it('exposes the well-known purposes', () => {
    expect(ACCOUNT_PURPOSE.EXPENSE).toBe('expense');
    expect(ACCOUNT_PURPOSE.REVENUE).toBe('revenue');
    expect(ACCOUNT_PURPOSE.PAYABLE).toBe('payable');
  });
});
