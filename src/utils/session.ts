/**
 * Shared session/transaction helpers.
 *
 * Provides a safe acquire/finalize pattern that:
 * - Detects standalone topology (no transactions) before starting one
 * - Manages commit/abort lifecycle with proper cleanup
 * - Always calls endSession() even when abort fails
 *
 * NOTE: session.startTransaction() is synchronous and does NOT throw on
 * standalone MongoDB — the "Transaction numbers are only allowed on a replica
 * set member or mongos" error only surfaces at the first database operation.
 * We detect standalone topology proactively via the driver's topology
 * description to avoid this trap.
 */

import type { ClientSession, Connection } from 'mongoose';
import type { Logger } from './logger.js';
import { defaultLogger } from './logger.js';

/**
 * Internal MongoDB driver topology detection.
 * `Connection.getClient()` is public but `topology` on the returned
 * MongoClient is an internal driver property not reflected in public types.
 */
interface MongoTopologyInternals {
  getClient?(): { topology?: { description?: { type?: string } } };
  client?: { topology?: { description?: { type?: string } } };
}

export interface SessionResult {
  session: ClientSession | null;
  ownSession: boolean;
}

/**
 * Acquire a session: uses external if provided, otherwise creates an internal one.
 * Returns { session, ownSession } so callers can commit/abort/end appropriately.
 *
 * When transactions are unavailable (no replica set / standalone), returns
 * session=null and the function runs without transactional safety.
 */
export async function acquireSession(
  db: Connection,
  externalSession: ClientSession | undefined | null,
  logger: Logger = defaultLogger,
): Promise<SessionResult> {
  if (externalSession) {
    return { session: externalSession, ownSession: false };
  }

  try {
    const session = await db.startSession();

    // Detect standalone topology before starting a transaction.
    try {
      const conn = db as unknown as MongoTopologyInternals;
      const client = conn.getClient?.() ?? conn.client;
      const topologyType = client?.topology?.description?.type;
      if (topologyType === 'Single') {
        session.endSession();
        logger.warn(
          'Transactions unavailable (standalone MongoDB). Operation is not atomic.',
        );
        return { session: null, ownSession: false };
      }
    } catch {
      // Topology detection failed — proceed optimistically
    }

    try {
      session.startTransaction();
      return { session, ownSession: true };
    } catch (err) {
      // startTransaction failed for unexpected reasons — clean up and fall back
      session.endSession();
      logger.warn(
        'Transactions unavailable (no replica set). Operation is not atomic.',
        { error: (err as Error).message },
      );
      return { session: null, ownSession: false };
    }
  } catch {
    // startSession itself failed — run without session
    return { session: null, ownSession: false };
  }
}

/**
 * Finalize an owned session: commit or abort, then always end.
 */
export async function finalizeSession(
  session: ClientSession | null,
  ownSession: boolean,
  success: boolean,
): Promise<void> {
  if (!ownSession || !session) return;

  try {
    if (success && session.inTransaction()) {
      await session.commitTransaction();
    } else if (!success && session.inTransaction()) {
      try {
        await session.abortTransaction();
      } catch {
        // Swallow abort errors — the original error is more important
      }
    }
  } finally {
    session.endSession();
  }
}
