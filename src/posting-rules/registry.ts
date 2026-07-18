/**
 * Posting-rule registry — packs contribute recipe batches, hosts override
 * individual recipes (strangler-friendly), and `validate()` sweeps every
 * slot reference at boot so a chart gap is ONE loud error listing every
 * failure — never a silent default account (the anti-SAP rule) and never a
 * first-request 500.
 */

import type { AccountRef, PostingRecipe, SlotResolver } from './types.js';
import { DuplicateRecipeError } from './types.js';

export interface RegisterPackOptions {
  /**
   * Slots the pack's recipes require BEYOND what is statically visible on
   * `{ slot }` refs — `route`/`resolve` modes compute their slot/code at
   * evaluation time, so packs declare those needs here for boot validation.
   */
  requiredSlots?: ReadonlyArray<string> | undefined;
}

export class PostingRuleRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: registry is heterogeneous by design — each recipe pins its own input type at definition site
  private readonly recipes = new Map<string, PostingRecipe<any>>();
  private readonly requiredSlots = new Set<string>();

  register<TInput>(recipe: PostingRecipe<TInput>): this {
    if (this.recipes.has(recipe.name)) throw new DuplicateRecipeError(recipe.name);
    this.recipes.set(recipe.name, recipe);
    return this;
  }

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous batch — members are self-typed at definition site
  registerPack(recipes: ReadonlyArray<PostingRecipe<any>>, options: RegisterPackOptions = {}): this {
    for (const recipe of recipes) this.register(recipe);
    for (const slot of options.requiredSlots ?? []) this.requiredSlots.add(slot);
    return this;
  }

  /** Deliberate replacement — host policy divergence. Throws if absent (a
   *  typo'd override would otherwise silently register a dead recipe). */
  override<TInput>(name: string, recipe: PostingRecipe<TInput>): this {
    if (!this.recipes.has(name)) {
      throw new Error(
        `Cannot override unknown posting recipe '${name}'. Registered: ${[...this.recipes.keys()].join(', ')}`,
      );
    }
    this.recipes.set(name, { ...recipe, name });
    return this;
  }

  // biome-ignore lint/suspicious/noExplicitAny: caller narrows via the recipe's own input type
  get(name: string): PostingRecipe<any> {
    const recipe = this.recipes.get(name);
    if (!recipe) {
      throw new Error(
        `Unknown posting recipe '${name}'. Registered: ${[...this.recipes.keys()].join(', ')}`,
      );
    }
    return recipe;
  }

  has(name: string): boolean {
    return this.recipes.has(name);
  }

  names(): string[] {
    return [...this.recipes.keys()];
  }

  /**
   * Boot-time sweep: every statically-declared slot on every registered
   * recipe, plus every pack-declared required slot, must resolve. Collects
   * ALL failures into one error so a chart gap is fixed in one pass.
   */
  validate(ctx: { slots: SlotResolver }): void {
    const missing: string[] = [];
    const seen = new Set<string>();

    const check = (slot: string, where: string) => {
      const key = `${slot} (${where})`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!ctx.slots(slot)) missing.push(key);
    };

    for (const recipe of this.recipes.values()) {
      for (const leg of recipe.legs) {
        const account = leg.account as AccountRef<unknown>;
        if ('slot' in account) check(account.slot, `${recipe.name}#${leg.id}`);
      }
    }
    for (const slot of this.requiredSlots) check(slot, 'pack requiredSlots');

    if (missing.length > 0) {
      throw new Error(
        `Posting-rule slot validation failed — the chart does not provide ${missing.length} slot(s):\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\nAdd the slots to the chart pack's alias map (fail-loud by design).`,
      );
    }
  }
}
