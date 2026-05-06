/**
 * Verify that the ledger engine exposes a QueryParser for consumers to
 * build URL-driven queries against ledger repositories.
 *
 * Consumers should be able to:
 *   1. Get a pre-configured parser from the engine
 *   2. Parse URL query params → ParsedQuery
 *   3. Pass ParsedQuery directly to repo.getAll()
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createAccountingEngine } from '../../src/engine';

const orgId = new mongoose.Types.ObjectId();

const testPack = {
  name: 'Test',
  code: 'TEST',
  accounts: [
    {
      code: '1000',
      name: 'Cash',
      statementType: 'Balance Sheet',
      mainType: 'Asset',
      isGroup: false,
      isTotal: false,
      parentCode: undefined,
      cashFlowCategory: 'Operating',
    },
    {
      code: '4000',
      name: 'Revenue',
      statementType: 'Income Statement',
      mainType: 'Income',
      isGroup: false,
      isTotal: false,
      parentCode: undefined,
    },
  ],
  journalTemplates: [],
  getPostingAccountTypes() {
    return this.accounts.filter((a: { isGroup: boolean; isTotal: boolean }) => !a.isGroup && !a.isTotal);
  },
  getAccountType(code: string) {
    return this.accounts.find((a: { code: string }) => a.code === code);
  },
  isValidAccountType(code: string) {
    return this.accounts.some((a: { code: string }) => a.code === code);
  },
  isPostingAccount(code: string) {
    const at = this.getAccountType(code);
    return at ? !at.isGroup && !at.isTotal : false;
  },
  getRetainedEarningsCode() {
    return '3600';
  },
};

let mongod: MongoMemoryServer;
let connection: mongoose.Connection;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongod.getUri()).asPromise();
});

afterAll(async () => {
  await connection?.close();
  await mongod?.stop();
});

describe('engine.createQueryParser()', () => {
  let engine: ReturnType<typeof createAccountingEngine>;

  beforeEach(async () => {
    const collections = await connection.db!.collections();
    for (const col of collections) await col.drop().catch(() => {});

    engine = createAccountingEngine({
      mongoose: connection,
      country: testPack as never,
      currency: 'USD',
      multiTenant: { tenantField: 'organizationId', ref: 'Organization' },
    });
  });

  it('exposes createQueryParser on the engine', () => {
    expect(typeof engine.createQueryParser).toBe('function');
  });

  it('returns a parser that produces ParsedQuery from URL params', () => {
    const parser = engine.createQueryParser('journalEntry');
    const parsed = parser.parse({
      'date[gte]': '2025-01-01',
      'date[lte]': '2025-12-31',
      sort: '-date',
      page: '1',
      limit: '20',
    });

    expect(parsed.filters).toBeDefined();
    expect(parsed.sort).toBeDefined();
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(20);
  });

  it('parsed query works with repo.getAll()', async () => {
    await engine.repositories.accounts.seedAccounts(orgId);

    const parser = engine.createQueryParser('account');
    const parsed = parser.parse({
      sort: 'accountNumber',
      limit: '10',
    });

    // getAll accepts ParsedQuery shape
    const result = await engine.repositories.accounts.getAll({
      ...parsed,
      filters: { ...parsed.filters, organizationId: orgId },
    });

    // Should return paginated docs
    expect(result).toBeDefined();
    // getAll returns either { docs } or an array depending on pagination
    const docs = Array.isArray(result) ? result : result.data;
    expect(docs.length).toBe(2); // 2 accounts from testPack
  });

  it('supports status filter via URL params', async () => {
    await engine.repositories.accounts.seedAccounts(orgId);

    const parser = engine.createQueryParser('account');
    const parsed = parser.parse({
      'active': 'true',
      limit: '50',
    });

    const result = await engine.repositories.accounts.getAll({
      ...parsed,
      filters: { ...parsed.filters, organizationId: orgId },
    });

    const docs = Array.isArray(result) ? result : result.data;
    expect(docs.length).toBeGreaterThan(0);
  });

  it('supports journal entry queries with date range', async () => {
    const parser = engine.createQueryParser('journalEntry');
    const parsed = parser.parse({
      'state': 'posted',
      'date[gte]': '2025-01-01',
      'date[lte]': '2025-03-31',
      sort: '-date',
      page: '1',
      limit: '25',
    });

    expect(parsed.filters.state).toBe('posted');
    expect(parsed.filters.date).toBeDefined();
    expect(parsed.limit).toBe(25);
  });

  it('respects maxLimit from pagination config', () => {
    const engine2 = createAccountingEngine({
      mongoose: connection,
      country: testPack as never,
      currency: 'USD',
      pagination: { journalEntry: { maxLimit: 50 } },
    });

    const parser = engine2.createQueryParser('journalEntry');
    const parsed = parser.parse({ limit: '999' });

    expect(parsed.limit).toBeLessThanOrEqual(50);
  });
});
