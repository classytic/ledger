/**
 * Reversal by derivation — `reversalOf(recipe)` flips every leg's side and
 * suffixes the idempotency key. The five hand-written reversal contracts in
 * the requirements corpus (vendor-bill, transfer dispatch/receive, COD
 * cancellation, landed-cost reverse) drift-proof by construction: a reversal
 * can never disagree with its original because it IS the original with sides
 * mirrored. Conditions, folds, group expansion, partner/maturity/FX stamping
 * all carry over untouched.
 */

import type { LegRule, PostingRecipe } from './types.js';

export interface ReversalOptions<TInput> {
  /** Registry name for the derived recipe. Default: `${original.name}.reversal`. */
  name?: string | undefined;
  /** Appended to the ORIGINAL's key: `${originalKey}${keySuffix}`. */
  keySuffix: string;
  /** Entry label. Default: `Reversal — ${original label}`. */
  label?: ((input: TInput) => string) | undefined;
  /** Reversals are corrections — default autoPost false unless overridden. */
  autoPost?: boolean | ((input: TInput) => boolean) | undefined;
}

export function reversalOf<TInput>(
  recipe: PostingRecipe<TInput>,
  options: ReversalOptions<TInput>,
): PostingRecipe<TInput> {
  const legs = recipe.legs.map(
    // biome-ignore lint/suspicious/noExplicitAny: mirrors the recipe's own heterogeneous leg typing
    (leg): LegRule<TInput, any> => ({
      ...leg,
      side: leg.side === 'debit' ? 'credit' : 'debit',
    }),
  );

  return {
    ...recipe,
    name: options.name ?? `${recipe.name}.reversal`,
    idempotencyKey: (input) => `${recipe.idempotencyKey(input)}${options.keySuffix}`,
    label: options.label ?? ((input) => `Reversal — ${recipe.label(input)}`),
    autoPost: options.autoPost ?? false,
    legs,
  };
}
