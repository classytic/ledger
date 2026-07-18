/**
 * @classytic/ledger/assurance — continuous integrity checks over the book.
 *
 * The third leg of the correctness stack:
 *   posting-rules  → drafts are provably balanced BEFORE they exist
 *   schema guards  → save-path writes can't break an entry
 *   assurance      → the persisted book is re-verified from raw items,
 *                    catching what bypassed both (bulk writes, migrations,
 *                    restores, index drops, subledger drift)
 */

export {
  checkControlAccounts,
  checkDuplicateIdempotency,
  checkEntryBalance,
  checkOrphanAccounts,
  checkStaleDrafts,
  checkTotalsDrift,
  checkTrialBalanceZero,
} from './checks.js';
export { runLedgerAssurance } from './run.js';
export type {
  AssuranceCheckResult,
  AssuranceReport,
  AssuranceSeverity,
  ControlAccountExpectation,
  LedgerAssuranceOptions,
  LedgerAssuranceParams,
} from './types.js';
