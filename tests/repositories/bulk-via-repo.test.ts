/**
 * Verify that seedAccounts and bulkCreate route through mongokit's
 * Repository.createMany() so plugins (before:createMany, after:createMany)
 * fire correctly.
 *
 * Previously these used Mongoose insertMany() directly, bypassing plugins.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { createAccountingEngine } from '../../src/engine';

const orgId = new mongoose.Types.ObjectId();

// Use a minimal country pack for testing
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
      code: '1200',
      name: 'Accounts Receivable',
      statementType: 'Balance Sheet',
      mainType: 'Asset',
      isGroup: false,
      isTotal: false,
      parentCode: undefined,
    },
    {
      code: '2000',
      name: 'Accounts Payable',
      statementType: 'Balance Sheet',
      mainType: 'Liability',
      isGroup: false,
      isTotal: false,
      parentCode: undefined,
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

describe('seedAccounts routes through repo.createMany()', () => {
  let engine: ReturnType<typeof createAccountingEngine>;

  beforeEach(async () => {
    // Drop all collections
    const collections = await connection.db!.collections();
    for (const col of collections) await col.drop().catch(() => {});

    engine = createAccountingEngine({
      mongoose: connection,
      country: testPack as never,
      currency: 'USD',
      multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
    });
  });

  it('seeds accounts and fires before:createMany hook', async () => {
    const hookCalls: string[] = [];
    engine.repositories.accounts.on('before:createMany', () => {
      hookCalls.push('before:createMany');
    });
    engine.repositories.accounts.on('after:createMany', () => {
      hookCalls.push('after:createMany');
    });

    const result = await engine.repositories.accounts.seedAccounts(orgId);

    expect(result.created).toBe(4);
    expect(hookCalls).toContain('before:createMany');
    expect(hookCalls).toContain('after:createMany');
  });

  it('seedAccounts is idempotent — second call skips existing', async () => {
    await engine.repositories.accounts.seedAccounts(orgId);
    const result = await engine.repositories.accounts.seedAccounts(orgId);

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(4);
  });
});

describe('bulkCreate routes through repo.createMany()', () => {
  let engine: ReturnType<typeof createAccountingEngine>;

  beforeEach(async () => {
    const collections = await connection.db!.collections();
    for (const col of collections) await col.drop().catch(() => {});

    engine = createAccountingEngine({
      mongoose: connection,
      country: testPack as never,
      currency: 'USD',
      multiTenant: { orgField: 'organizationId', orgRef: 'Organization' },
    });
  });

  it('bulk creates accounts and fires createMany hooks', async () => {
    const hookCalls: string[] = [];
    engine.repositories.accounts.on('before:createMany', () => {
      hookCalls.push('before:createMany');
    });
    engine.repositories.accounts.on('after:createMany', () => {
      hookCalls.push('after:createMany');
    });

    const result = await engine.repositories.accounts.bulkCreate(
      [
        { accountTypeCode: '1000', name: 'Cash' },
        { accountTypeCode: '1200', name: 'AR' },
      ],
      orgId,
    );

    expect(result.summary.created).toBe(2);
    expect(hookCalls).toContain('before:createMany');
    expect(hookCalls).toContain('after:createMany');
  });

  it('skips existing accounts without errors', async () => {
    await engine.repositories.accounts.bulkCreate(
      [{ accountTypeCode: '1000', name: 'Cash' }],
      orgId,
    );

    const result = await engine.repositories.accounts.bulkCreate(
      [
        { accountTypeCode: '1000', name: 'Cash' },       // existing
        { accountTypeCode: '4000', name: 'Revenue' },     // new
      ],
      orgId,
    );

    expect(result.summary.created).toBe(1);
    expect(result.summary.skipped).toBe(1);
  });

  it('validates posting accounts', async () => {
    const result = await engine.repositories.accounts.bulkCreate(
      [{ accountTypeCode: 'INVALID_CODE' }],
      orgId,
    );

    expect(result.summary.errors).toBe(1);
    expect(result.errors[0]).toMatchObject({ reason: 'Invalid account type code' });
  });
});
