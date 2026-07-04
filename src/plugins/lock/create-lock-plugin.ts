/**
 * `createLockPlugin` — the factory behind every lock scope.
 *
 * Handles all the boilerplate that every lock plugin needs:
 *
 *   - Skips draft entries (state !== 'posted')
 *   - Skips legitimate internal state transitions flagged via
 *     `_ledgerInternal` (post / unpost / archive / reverseMark)
 *   - Resolves the entry date from payload, falling back to the
 *     persisted doc on partial updates
 *   - Resolves the multi-tenant scope value from payload → context
 *     → persisted doc, refusing to run unscoped queries when
 *     `orgField` is configured
 *   - Fetches referenced account docs and applies `accountSelector`
 *     to decide whether the lock applies at all
 *   - Delegates the final "is this slice closed?" decision to the
 *     supplied `resolve` function
 *   - Converts a `LockHit` into a typed `AccountingError` with a
 *     409 status and `PERIOD_LOCKED_{SCOPE}` code
 *
 * Scope-specific logic lives in the resolver, not in here.
 */

import type { RepositoryContext, RepositoryInstance } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import { Errors } from '../../utils/errors.js';
import {
  type ClaimRepositoryContext,
  flattenClaimData,
  isReverseMarkClaim,
} from '../claim-context.js';
import type { CreateLockPluginOptions, LockHit } from './types.js';

type DataBag = Record<string, unknown>;

export function createLockPlugin(options: CreateLockPluginOptions) {
  const { scope, resolve, accountSelector, AccountModel, JournalEntryModel, orgField } = options;

  if (accountSelector && !AccountModel) {
    throw new Error(
      `createLockPlugin({ scope: '${scope}' }): accountSelector requires AccountModel.`,
    );
  }

  return {
    name: `accounting:lock:${scope}`,
    apply(repo: RepositoryInstance) {
      const run = async (context: RepositoryContext, isUpdate: boolean) => {
        const data = context.data as DataBag | undefined;
        if (!data) return;

        // Draft entries never hit locks.
        if (data.state !== 'posted') return;

        // `reverseMark` is the only internal transition exempt from locks:
        // it updates the original entry (`reversed=true`, `reversedBy=...`)
        // which may legitimately sit inside a closed period — the new
        // counter-entry still goes through this pipeline independently and
        // is subject to the lock on its own (reversal) date.
        //
        // `post` and `unpost` intentionally DO fire the lock: you cannot
        // post into a closed period, and you cannot unpost an entry whose
        // original date sits inside one. `archive` only runs on drafts, so
        // the `state !== 'posted'` guard above already short-circuits it.
        if (context._ledgerInternal === 'reverseMark') return;

        const session = (context.session ?? null) as ClientSession | null;

        // ── 1. Resolve entry date ──────────────────────────────────────
        let entryDate: Date | undefined;
        let persistedDoc: DataBag | null = null;

        if (data.date) {
          entryDate = new Date(data.date as string | number | Date);
        } else if (!isUpdate) {
          // Schema defaults unset `date` to `now` — check against now.
          entryDate = new Date();
        } else {
          if (!context.id) {
            throw new Error(
              `lockPlugin[${scope}]: update context is missing "id". Cannot validate lock without document ID.`,
            );
          }
          if (!JournalEntryModel) {
            throw new Error(
              `lockPlugin[${scope}]: JournalEntryModel is required to validate partial updates that set state to "posted".`,
            );
          }
          const selectFields = orgField ? `date ${orgField} journalItems` : 'date journalItems';
          persistedDoc = (await JournalEntryModel.findById(context.id)
            .select(selectFields)
            .session(session)
            .lean()) as DataBag | null;
          if (persistedDoc?.date) {
            entryDate = new Date(persistedDoc.date as string | number | Date);
          }
        }

        if (!entryDate) return;

        // ── 2. Resolve org scope ───────────────────────────────────────
        let orgValue: unknown;
        if (orgField) {
          orgValue = data[orgField] ?? (context as DataBag)[orgField];

          if (!orgValue && isUpdate) {
            if (persistedDoc) {
              orgValue = persistedDoc[orgField];
            } else if (context.id && JournalEntryModel) {
              const persisted = (await JournalEntryModel.findById(context.id)
                .select(orgField)
                .session(session)
                .lean()) as DataBag | null;
              if (persisted) orgValue = persisted[orgField];
            }
          }

          if (!orgValue) {
            throw new Error(
              `lockPlugin[${scope}]: orgField "${orgField}" is configured but could not be resolved from payload, context, or persisted document.`,
            );
          }
        }

        // ── 3. Account selector (narrow by touched accounts) ──────────
        if (accountSelector && AccountModel) {
          const items = (data.journalItems ?? persistedDoc?.journalItems ?? []) as Array<
            Record<string, unknown>
          >;
          const accountIds = items
            .map((i) => {
              const a = i.account;
              if (typeof a === 'object' && a !== null) {
                return (a as DataBag)._id ?? a;
              }
              return a;
            })
            .filter((id) => id != null);

          if (accountIds.length === 0) return;

          const accounts = (await AccountModel.find({ _id: { $in: accountIds } })
            .session(session)
            .lean()) as DataBag[];

          const touched = accounts.some((acc) => accountSelector(acc));
          if (!touched) return;
        }

        // ── 4. Delegate to the resolver ────────────────────────────────
        const hit: LockHit | null = await resolve({
          entryDate,
          orgValue,
          session,
          data,
          repositoryContext: context,
        });

        if (!hit) return;

        // ── 5. Throw a typed error ─────────────────────────────────────
        const datePart = entryDate.toISOString().split('T')[0];
        const subTypePart = hit.subType ? ` [${hit.subType}]` : '';
        const refPart = hit.externalRef ? ` (ref: ${hit.externalRef})` : '';
        throw Errors.locked(
          hit.scope,
          `Cannot post entry dated ${datePart}: ${hit.scope}${subTypePart} period "${hit.label}" is closed${refPart}.`,
        );
      };

      const runMany = async (context: RepositoryContext) => {
        const docs = context.dataArray as Array<Record<string, unknown>> | undefined;
        if (!docs || docs.length === 0) return;

        for (const data of docs) {
          if (data.state !== 'posted') continue;
          // Build a synthetic single-doc context for the shared `run` logic.
          // Only fields read by `run` need to be present.
          const singleCtx: RepositoryContext = {
            ...context,
            data,
            dataArray: undefined,
          } as unknown as RepositoryContext;
          await run(singleCtx, false);
        }
      };

      // ── before:claim — atomic state-machine CAS ────────────────────────
      //
      // Lock checks must fire on `repo.claim(id, { from: 'draft', to:
      // 'posted' })` — the post() verb migrated to claim() in 0.10.6 for
      // race-safe state transitions, and without this hook the fiscal /
      // daily / custom locks would silently let posts into closed periods
      // through.
      //
      // Reverse-mark (the state-noop CAS that stamps `reversed: true` on
      // the original entry) is exempt for the same reason `_ledgerInternal
      // === 'reverseMark'` was exempt on update: the original entry's date
      // may legitimately sit in a closed period, and the new counter-entry
      // hits this pipeline on its own (reversal-date-driven) lock check.
      const runClaim = async (rawCtx: RepositoryContext) => {
        const ctx = rawCtx as ClaimRepositoryContext;
        if (isReverseMarkClaim(ctx)) return;
        // Lock checks only matter for transitions to `posted`.
        if (ctx.transition?.to !== 'posted') return;
        // Build an update-shaped synthetic context so the existing `run`
        // logic (date resolution, scope resolution, account selector,
        // resolver call) works unchanged.
        const syntheticCtx: RepositoryContext = {
          ...ctx,
          data: flattenClaimData(ctx),
        } as unknown as RepositoryContext;
        await run(syntheticCtx, true);
      };

      repo.on('before:create', (ctx: RepositoryContext) => run(ctx, false));
      repo.on('before:createMany', runMany);
      repo.on('before:update', (ctx: RepositoryContext) => run(ctx, true));
      repo.on('before:claim', runClaim);
      // claimVersion (mongokit 3.16) carries an operator-shaped update —
      // unwrap the `$set` view so the same update-path lock logic applies.
      // Draft-scoped writes (the engine's `updateDraft()`) short-circuit on
      // the `state !== 'posted'` guard exactly like plain updates.
      repo.on('before:claimVersion', (ctx: RepositoryContext) => {
        const data = ctx.data as Record<string, unknown> | undefined;
        const set =
          data && '$set' in data ? ((data.$set ?? {}) as Record<string, unknown>) : (data ?? {});
        return run({ ...ctx, data: set } as RepositoryContext, true);
      });
    },
  };
}
