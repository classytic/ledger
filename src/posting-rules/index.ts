/**
 * `@classytic/ledger/posting-rules` — typed, package-composable subledger
 * posting-rule engine. Design: docs/posting-rules-design.md.
 *
 * Recipes are typed data objects with pure-function leaves, distributed as
 * npm packs (jurisdiction packs like `@classytic/ledger-bd` export recipe
 * batches; hosts provide the chart slot map and may override individual
 * recipes). The evaluator is a pure single pass producing an explainable
 * PostingDraft; posting itself stays on the ledger's idempotent journal
 * entry path.
 */

export { evaluatePostingRecipe } from './evaluate.js';
export { reversalOf, type ReversalOptions } from './reversal.js';
export { PostingRuleRegistry, type RegisterPackOptions } from './registry.js';
export { assertDeterministic, expectRecipe, type ExpectedLeg } from './test-kit.js';
export {
  DuplicateRecipeError,
  UnbalancedRecipeError,
  UnknownFoldTargetError,
  UnknownSlotError,
  type AccountRef,
  type DraftLeg,
  type EvaluateContext,
  type LegExplain,
  type LegRule,
  type PostingDraft,
  type PostingRecipe,
  type RecipeFx,
  type RecipePartner,
  type RecipeSourceRef,
  type SlotResolver,
} from './types.js';
