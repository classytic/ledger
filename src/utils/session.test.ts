/**
 * Session Helper Tests
 *
 * Tests acquireSession and finalizeSession for transaction management.
 * Uses MongoMemoryServer (standalone topology — no replica set)
 * to verify graceful fallback behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { acquireSession, finalizeSession } from './session.js';
import type { ClientSession } from 'mongoose';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('acquireSession', () => {
  it('returns external session when provided', async () => {
    const mockSession = { id: 'external' } as unknown as ClientSession;
    const result = await acquireSession(mongoose.connection, mockSession);

    expect(result.session).toBe(mockSession);
    expect(result.ownSession).toBe(false);
  });

  it('falls back to null session on standalone MongoDB (no replica set)', async () => {
    const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const result = await acquireSession(mongoose.connection, null, silentLogger);

    // MongoMemoryServer is standalone — transactions not available
    expect(result.session).toBeNull();
    expect(result.ownSession).toBe(false);
  });

  it('returns null session when external is null', async () => {
    const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const result = await acquireSession(mongoose.connection, null, silentLogger);

    expect(result.session).toBeNull();
  });

  it('returns null session when external is undefined', async () => {
    const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const result = await acquireSession(mongoose.connection, undefined, silentLogger);

    expect(result.session).toBeNull();
  });
});

describe('finalizeSession', () => {
  it('no-ops when session is null', async () => {
    // Should not throw
    await finalizeSession(null, true, true);
    await finalizeSession(null, true, false);
    await finalizeSession(null, false, true);
  });

  it('no-ops when ownSession is false (external session)', async () => {
    const mockSession = {
      inTransaction: () => true,
      commitTransaction: () => { throw new Error('should not commit'); },
      abortTransaction: () => { throw new Error('should not abort'); },
      endSession: () => { throw new Error('should not end'); },
    } as unknown as ClientSession;

    // Should not commit/abort/end an external session
    await finalizeSession(mockSession, false, true);
    await finalizeSession(mockSession, false, false);
  });

  it('commits on success when in transaction', async () => {
    let committed = false;
    let ended = false;
    const mockSession = {
      inTransaction: () => true,
      commitTransaction: async () => { committed = true; },
      endSession: () => { ended = true; },
    } as unknown as ClientSession;

    await finalizeSession(mockSession, true, true);
    expect(committed).toBe(true);
    expect(ended).toBe(true);
  });

  it('aborts on failure when in transaction', async () => {
    let aborted = false;
    let ended = false;
    const mockSession = {
      inTransaction: () => true,
      abortTransaction: async () => { aborted = true; },
      endSession: () => { ended = true; },
    } as unknown as ClientSession;

    await finalizeSession(mockSession, true, false);
    expect(aborted).toBe(true);
    expect(ended).toBe(true);
  });

  it('still ends session even if abort throws', async () => {
    let ended = false;
    const mockSession = {
      inTransaction: () => true,
      abortTransaction: async () => { throw new Error('abort failed'); },
      endSession: () => { ended = true; },
    } as unknown as ClientSession;

    await finalizeSession(mockSession, true, false);
    expect(ended).toBe(true); // endSession called despite abort error
  });

  it('does not commit/abort when not in transaction', async () => {
    let ended = false;
    const mockSession = {
      inTransaction: () => false,
      commitTransaction: async () => { throw new Error('should not commit'); },
      abortTransaction: async () => { throw new Error('should not abort'); },
      endSession: () => { ended = true; },
    } as unknown as ClientSession;

    await finalizeSession(mockSession, true, true);
    expect(ended).toBe(true);

    ended = false;
    await finalizeSession(mockSession, true, false);
    expect(ended).toBe(true);
  });
});
