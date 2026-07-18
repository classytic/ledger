/**
 * Posting-rule test kit — per-pack contract floors in the arc-testkit
 * tradition, plus the determinism check that enforces the purity contract.
 *
 *   expectRecipe(recipe)
 *     .withSlots({ ar: '1141', revenue: '4111' })
 *     .given(input)
 *     .toPost([{ slot: 'ar', debit: 100_00 }, { slot: 'revenue', credit: 100_00 }]);
 *
 * Matching is order-insensitive; failures print a precise side-by-side diff
 * (expected vs actual legs) instead of a deep-equal blob.
 */

import { evaluatePostingRecipe } from './evaluate.js';
import type { PostingDraft, PostingRecipe, RecipePartner, SlotResolver } from './types.js';

export interface ExpectedLeg {
  /** Match by slot (resolved through the provided slot map) or literal code. */
  slot?: string | undefined;
  code?: string | undefined;
  debit?: number | undefined;
  credit?: number | undefined;
  partner?: RecipePartner | undefined;
  /** Substring match on the leg label (labels are templates; pin fragments). */
  labelIncludes?: string | undefined;
}

function legLine(l: { accountCode: string; side: string; amount: number; legId?: string }): string {
  return `${l.legId ? `[${l.legId}] ` : ''}${l.accountCode} ${l.side} ${l.amount}`;
}

class RecipeExpectation<TInput> {
  constructor(
    private readonly recipe: PostingRecipe<TInput>,
    private readonly slots: SlotResolver,
    private readonly input: TInput,
  ) {}

  evaluate(): PostingDraft {
    return evaluatePostingRecipe(this.recipe, this.input, { slots: this.slots });
  }

  /** Order-insensitive leg matching with a readable diff on failure. */
  toPost(expected: ReadonlyArray<ExpectedLeg>): PostingDraft {
    const draft = this.evaluate();
    const remaining = [...draft.legs];
    const failures: string[] = [];

    for (const exp of expected) {
      const wantCode = exp.code ?? (exp.slot ? this.slots(exp.slot) : undefined);
      const wantSide = exp.debit !== undefined ? 'debit' : 'credit';
      const wantAmount = exp.debit ?? exp.credit;
      const idx = remaining.findIndex(
        (l) =>
          (wantCode === undefined || l.accountCode === wantCode) &&
          l.side === wantSide &&
          (wantAmount === undefined || l.amount === wantAmount) &&
          (exp.partner === undefined ||
            (l.partner?.partnerId === exp.partner.partnerId &&
              l.partner?.partnerType === exp.partner.partnerType)) &&
          (exp.labelIncludes === undefined || l.label.includes(exp.labelIncludes)),
      );
      if (idx === -1) {
        failures.push(
          `MISSING expected leg: ${wantCode ?? exp.slot ?? '?'} ${wantSide} ${wantAmount ?? '?'}` +
            (exp.labelIncludes ? ` label~"${exp.labelIncludes}"` : ''),
        );
      } else {
        remaining.splice(idx, 1);
      }
    }
    for (const extra of remaining) failures.push(`UNEXPECTED leg: ${legLine(extra)}`);

    if (failures.length > 0) {
      throw new Error(
        `Recipe '${draft.recipeName}' draft mismatch:\n` +
          failures.map((f) => `  ${f}`).join('\n') +
          `\nActual legs:\n${draft.legs.map((l) => `  ${legLine(l)}`).join('\n')}`,
      );
    }
    return draft;
  }

  toHaveKey(key: string): PostingDraft {
    const draft = this.evaluate();
    if (draft.idempotencyKey !== key) {
      throw new Error(`Recipe '${draft.recipeName}' key mismatch: expected '${key}', got '${draft.idempotencyKey}'`);
    }
    return draft;
  }

  toBalance(): PostingDraft {
    // evaluate() already throws UnbalancedRecipeError on imbalance.
    return this.evaluate();
  }

  /** The intentional-no-op contract: zero legs, skipped: true. */
  toSkip(): PostingDraft {
    const draft = this.evaluate();
    if (!draft.skipped || draft.legs.length > 0) {
      throw new Error(
        `Recipe '${draft.recipeName}' expected to SKIP but produced ${draft.legs.length} leg(s):\n` +
          draft.legs.map((l) => `  ${legLine(l)}`).join('\n'),
      );
    }
    return draft;
  }
}

class RecipeExpectationBuilder<TInput> {
  private slots: SlotResolver = () => undefined;

  constructor(private readonly recipe: PostingRecipe<TInput>) {}

  withSlots(map: Record<string, string> | SlotResolver): this {
    this.slots = typeof map === 'function' ? map : (slot) => map[slot];
    return this;
  }

  given(input: TInput): RecipeExpectation<TInput> {
    return new RecipeExpectation(this.recipe, this.slots, input);
  }
}

export function expectRecipe<TInput>(recipe: PostingRecipe<TInput>): RecipeExpectationBuilder<TInput> {
  return new RecipeExpectationBuilder(recipe);
}

/**
 * Purity enforcement: evaluate twice, require byte-identical drafts. Fails
 * on Date.now(), randomness, or any hidden state — the contract every
 * recipe function signs (see types.ts module doc).
 */
export function assertDeterministic<TInput>(
  recipe: PostingRecipe<TInput>,
  input: TInput,
  slots: Record<string, string> | SlotResolver,
): void {
  const resolver: SlotResolver = typeof slots === 'function' ? slots : (slot) => slots[slot];
  const a = evaluatePostingRecipe(recipe, input, { slots: resolver });
  const b = evaluatePostingRecipe(recipe, input, { slots: resolver });
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    throw new Error(
      `Recipe '${recipe.name}' is non-deterministic — two evaluations of the same input differ. ` +
        `Recipes must be pure functions of their input (no Date.now(), no randomness).`,
    );
  }
}
