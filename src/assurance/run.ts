/**
 * Assurance runner — executes every applicable check and folds the results
 * into one report. Checks run sequentially (they're aggregation-heavy; a
 * sweep favors predictable DB load over latency).
 */

import {
  checkControlAccounts,
  checkDuplicateIdempotency,
  checkEntryBalance,
  checkOrphanAccounts,
  checkStaleDrafts,
  checkTotalsDrift,
  checkTrialBalanceZero,
} from './checks.js';
import type {
  AssuranceCheckResult,
  AssuranceReport,
  LedgerAssuranceOptions,
  LedgerAssuranceParams,
} from './types.js';

export async function runLedgerAssurance(
  opts: LedgerAssuranceOptions,
  params: LedgerAssuranceParams = {},
): Promise<AssuranceReport> {
  const results: AssuranceCheckResult[] = [
    await checkEntryBalance(opts, params),
    await checkTotalsDrift(opts, params),
    await checkTrialBalanceZero(opts, params),
    await checkOrphanAccounts(opts, params),
    await checkDuplicateIdempotency(opts, params),
  ];

  if (params.controlAccounts && params.controlAccounts.length > 0) {
    results.push(await checkControlAccounts(opts, params, params.controlAccounts));
  }
  if (params.staleDraftDays !== undefined) {
    results.push(
      await checkStaleDrafts(opts, params, params.staleDraftDays, params.now ?? new Date()),
    );
  }

  return {
    ...(params.organizationId !== undefined ? { organizationId: params.organizationId } : {}),
    until: params.until,
    ok: results.every((r) => r.ok || r.severity !== 'error'),
    results,
  };
}
