/**
 * Posting-recipe evaluator — single pass, pure, no IO.
 *
 * Same input + same slot map → same draft, always. That determinism is the
 * design's answer to Odoo's account.move synchronization complexity and to
 * Oracle SLA's opaque Create Accounting runs: there is nothing to observe
 * at "posting time" that wasn't already fully decided here, and the explain
 * block on every leg is populated unconditionally (tracing is a property of
 * the data structure, not a diagnostics mode).
 *
 * Evaluation order (docs/posting-rules-design.md §3.4):
 *   1. Expand each leg (group legs produce one physical leg per item).
 *   2. Run the when-guard (default `amount > 0` unless a custom `when`).
 *   3. Resolve the account per mode; `resolve → null` marks the leg's
 *      amount to FOLD into its `foldInto` target.
 *   4. Apply folds (target legs absorb folded amounts; explain records it).
 *   5. Enforce Σdebit = Σcredit — throw UnbalancedRecipeError otherwise.
 */

import type {
  AccountRef,
  DraftLeg,
  EvaluateContext,
  LegExplain,
  LegRule,
  PostingDraft,
  PostingRecipe,
} from './types.js';
import { UnbalancedRecipeError, UnknownFoldTargetError, UnknownSlotError } from './types.js';

interface PendingLeg {
  draft: DraftLeg;
  /** Set when this leg's resolve() returned null — amount folds away. */
  foldTo?: string | undefined;
}

function resolveAccount<TItem>(
  recipeName: string,
  leg: LegRule<never, TItem>,
  item: TItem,
  ctx: EvaluateContext,
): { mode: LegExplain['accountMode']; code: string | null; slot?: string | undefined } {
  const account = leg.account as AccountRef<TItem>;
  if ('slot' in account) {
    const code = ctx.slots(account.slot);
    if (!code) throw new UnknownSlotError(recipeName, leg.id, account.slot);
    return { mode: 'slot', code, slot: account.slot };
  }
  if ('route' in account) {
    const slot = account.route(item);
    const code = ctx.slots(slot);
    if (!code) throw new UnknownSlotError(recipeName, leg.id, slot);
    return { mode: 'route', code, slot };
  }
  if ('resolve' in account) {
    // Nullable by contract — null folds the amount into `foldInto`.
    return { mode: 'resolve', code: account.resolve(item) };
  }
  return { mode: 'code', code: account.code(item) };
}

export function evaluatePostingRecipe<TInput>(
  recipe: PostingRecipe<TInput>,
  input: TInput,
  ctx: EvaluateContext,
): PostingDraft {
  const pending: PendingLeg[] = [];
  const legIds = new Set(recipe.legs.map((l) => l.id));

  for (const leg of recipe.legs) {
    // Group legs evaluate once per expanded item; plain legs once with input.
    const items: ReadonlyArray<unknown> = leg.expand ? leg.expand(input) : [input];

    for (const item of items) {
      const amount = leg.amount(item);
      const conditionResult = leg.when ? leg.when(item) : amount > 0;
      if (!conditionResult) continue; // conditioned out — not part of the draft

      const account = leg.account as AccountRef<unknown>;
      if ('resolve' in account && !legIds.has(account.foldInto)) {
        throw new UnknownFoldTargetError(recipe.name, leg.id, account.foldInto);
      }

      const resolved = resolveAccount(recipe.name, leg as LegRule<never, unknown>, item, ctx);
      const folds = resolved.code === null;

      const explain: LegExplain = {
        legId: leg.id,
        accountMode: resolved.mode,
        slot: resolved.slot,
        resolvedCode: resolved.code ?? '(folded)',
        conditionResult,
      };

      const partner = leg.partner?.(item);
      const maturityDate = leg.maturityDate?.(item);
      const fx = leg.fx?.(item);
      pending.push({
        draft: {
          legId: leg.id,
          accountCode: resolved.code ?? '',
          side: leg.side,
          amount,
          label: leg.label(item),
          ...(partner !== undefined ? { partner } : {}),
          ...(maturityDate !== undefined ? { maturityDate } : {}),
          ...(fx !== undefined ? { fx } : {}),
          explain,
        },
        foldTo: folds ? (account as { foldInto: string }).foldInto : undefined,
      });
    }
  }

  // Apply folds: the folding leg vanishes; its amount lands on the SAME-SIDE
  // target leg (the corpus pattern: non-claimable input VAT folds into the
  // inventory debit). Fold provenance is stamped on the target's explain.
  const legs: DraftLeg[] = [];
  for (const p of pending) {
    if (p.foldTo === undefined) {
      legs.push(p.draft);
      continue;
    }
    const target = pending.find((t) => t.draft.legId === p.foldTo && t.foldTo === undefined);
    if (!target) {
      // Target itself conditioned out or folded — a recipe bug, surface as unbalance below
      // by keeping the leg with no account; but fail precisely instead:
      throw new UnknownFoldTargetError(recipe.name, p.draft.legId, p.foldTo);
    }
    target.draft.amount += p.draft.amount;
    target.draft.explain.folded = { fromLegId: p.draft.legId, amount: p.draft.amount };
  }

  const totals = legs.reduce(
    (acc, l) => {
      if (l.side === 'debit') acc.debit += l.amount;
      else acc.credit += l.amount;
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  const skipped = legs.length === 0;
  if (!skipped && totals.debit !== totals.credit) {
    throw new UnbalancedRecipeError(
      recipe.name,
      totals,
      legs.map((l) => ({ legId: l.legId, side: l.side, amount: l.amount })),
    );
  }

  const autoPost = typeof recipe.autoPost === 'function' ? recipe.autoPost(input) : recipe.autoPost;
  const date = recipe.date?.(input);
  const organizationId = recipe.organizationId?.(input);
  const sourceRef = recipe.sourceRef?.(input);
  const metadata = recipe.metadata?.(input);

  return {
    recipeName: recipe.name,
    journalType: typeof recipe.journalType === 'function' ? recipe.journalType(input) : recipe.journalType,
    idempotencyKey: recipe.idempotencyKey(input),
    label: recipe.label(input),
    autoPost,
    ...(date !== undefined ? { date } : {}),
    ...(organizationId !== undefined ? { organizationId } : {}),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    legs,
    totals,
    skipped,
  };
}
