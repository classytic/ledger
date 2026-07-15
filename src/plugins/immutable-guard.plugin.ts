/**
 * Immutable Guard Plugin (0.11.0)
 *
 * Enforces `config.strictness.immutable === true`: posted journal
 * entries are frozen audit records — the only way to correct one is
 * `reverse()`, which creates a counter-entry. The engine's own
 * transition verbs (`post`, `unpost`, `reverse`, `archive`) pass
 * `_ledgerInternal: '<op>'` and are permitted; direct repository
 * callers have no way to set the flag, so they hit the guard.
 *
 * Since 0.11.0 this is a thin configuration of mongokit's
 * `immutableStatesPlugin` (which was PROMOTED from this file's 0.9.0
 * hand-rolled implementation). The promotion is a strict superset —
 * it CLOSES real gaps the hand-rolled version had:
 *
 *   - `findOneAndUpdate` / `updateMany` / `deleteMany` / `bulkWrite` /
 *     `restore` on the JE repository were previously UNFENCED — a host
 *     could mutate a posted entry through any of them without tripping
 *     `strictness.immutable`.
 *   - a `claim` on a NON-state field (which doesn't CAS-pin `state`)
 *     could patch a posted entry; it now falls back to a state lookup.
 *
 * The reverse-mark stamp (`posted → posted` with the
 * `reversed: { $ne: true }` race guard and a `reversed: true` $set)
 * stays exempt via `allowClaim` — same fingerprint as before, see
 * `isReverseMarkClaim`.
 *
 * Engine-internal raw-Model paths (e.g. reconciliation's
 * `JournalEntryModel.bulkWrite`) bypass the repo hook pipeline by
 * design and are unaffected.
 */

import { immutableStatesPlugin, type PluginType } from '@classytic/mongokit';
import { ImmutableViolationError } from '../utils/errors.js';
import { type ClaimRepositoryContext, isReverseMarkClaim } from './claim-context.js';

export interface ImmutableGuardOptions {
  /** Multi-tenant org field name (if enabled). */
  orgField?: string | undefined;
}

/**
 * Returns the configured plugin. Install only when
 * `config.strictness.immutable === true`.
 */
export function immutableGuardPlugin(options: ImmutableGuardOptions = {}): PluginType {
  return immutableStatesPlugin({
    states: ['posted'],
    field: 'state',
    internalFlag: '_ledgerInternal',
    ...(options.orgField !== undefined ? { tenantField: options.orgField } : {}),
    allowClaim: (view) =>
      isReverseMarkClaim({
        transition: view.transition,
        data: view.data,
      } as ClaimRepositoryContext),
    errorFactory: ({ id }) => new ImmutableViolationError(id),
  });
}
