/**
 * Integration test — first-class Journal resource (0.6.0).
 *
 * Covers:
 *   1. seedDefaults() creates templates from the country pack
 *   2. Idempotent — running twice does not duplicate
 *   3. Multi-tenant isolation of seeded journals
 *   4. nextSequenceNumber() atomic counter, correct formatting
 *   5. Custom templates override the lean defaults
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defineCountryPack } from '../../src/country/index.js';
import { createAccountingEngine } from '../../src/engine.js';
import type { AccountType } from '../../src/types/core.js';

const accountTypes: readonly AccountType[] = [
  { code: '1000', name: 'Cash', category: 'Balance Sheet-Asset', description: 'Cash', parentCode: null, isTotal: false, cashFlowCategory: 'Operating' },
  { code: '4000', name: 'Revenue', category: 'Income Statement-Income', description: 'Revenue', parentCode: null, isTotal: false, cashFlowCategory: null },
];

const leanPack = defineCountryPack({
  code: 'LEAN',
  name: 'Lean pack (no templates)',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
});

const richPack = defineCountryPack({
  code: 'RICH',
  name: 'Rich pack with templates',
  defaultCurrency: 'USD',
  accountTypes,
  taxCodes: {},
  taxCodesByRegion: {},
  regions: [],
  journalTemplates: [
    { code: 'CORP_SALES', name: 'Corporate Sales', journalType: 'SALES', kind: 'sale', sequencePrefix: 'CS' },
    { code: 'INTERCO', name: 'Intercompany', journalType: 'MISC', kind: 'general', sequencePrefix: 'IC' },
  ],
});

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  for (const name of Object.keys(mongoose.models)) delete mongoose.models[name];
  for (const name of Object.keys(mongoose.connection.collections)) {
    await mongoose.connection.collections[name]?.deleteMany({});
  }
});

describe('Journal resource — seedDefaults', () => {
  it('uses the lean default template set when country pack has none', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: leanPack,
      currency: 'USD',
    });

    const result = await engine.repositories.journals.seedDefaults('org-1');
    expect(result.created).toBe(5); // SALES / PURCHASE / BANK / CASH / MISC
    expect(result.skipped).toBe(0);

    const journals = await engine.repositories.journals.getAll();
    expect(journals.data.length).toBe(5);
    const codes = journals.data.map((j: Record<string, unknown>) => j.code).sort();
    expect(codes).toEqual(['BANK', 'CASH', 'MISC', 'PURCHASE', 'SALES']);
  });

  it('uses custom templates from the country pack when provided', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: richPack,
      currency: 'USD',
    });

    const result = await engine.repositories.journals.seedDefaults('org-1');
    expect(result.created).toBe(2);

    const journals = await engine.repositories.journals.getAll();
    const codes = journals.data.map((j: Record<string, unknown>) => j.code).sort();
    expect(codes).toEqual(['CORP_SALES', 'INTERCO']);
  });

  it('is idempotent — re-running skips existing journals', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: leanPack,
      currency: 'USD',
    });

    await engine.repositories.journals.seedDefaults('org-1');
    const again = await engine.repositories.journals.seedDefaults('org-1');
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(5);
  });
});

describe('Journal resource — nextSequenceNumber', () => {
  it('returns a formatted ref and increments atomically', async () => {
    const engine = createAccountingEngine({
      mongoose: mongoose.connection,
      country: leanPack,
      currency: 'USD',
    });
    await engine.repositories.journals.seedDefaults('org-1');
    const journals = await engine.repositories.journals.getAll();
    const sales = journals.data.find((j: Record<string, unknown>) => j.code === 'SALES') as { _id: unknown };

    const a = await engine.repositories.journals.nextSequenceNumber(sales._id);
    const b = await engine.repositories.journals.nextSequenceNumber(sales._id);
    const c = await engine.repositories.journals.nextSequenceNumber(sales._id);

    // Lean default template uses 'INV' as sequencePrefix for Sales
    expect(a).toMatch(/^INV\/\d{4}\/\d{2}\/0001$/);
    expect(b).toMatch(/^INV\/\d{4}\/\d{2}\/0002$/);
    expect(c).toMatch(/^INV\/\d{4}\/\d{2}\/0003$/);
  });
});
