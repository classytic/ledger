/**
 * Posting Rules — typed recipe model.
 *
 * A PostingRecipe is a TYPED DATA OBJECT whose leaves are pure functions:
 * the STRUCTURE (legs, sides, account references, conditions, idempotency,
 * journal type) is declarative and introspectable — that is what the engine
 * validates, traces, reverses, and documents — while AMOUNTS are pure typed
 * functions of the input (full inference, compile-time account checking,
 * trivially unit-testable, no expression-language runtime).
 *
 * This is the deliberate divergence from every incumbent: Oracle SLA / SAP
 * put rules in runtime configuration (setup sprawl, debugging opacity),
 * NetSuite puts them in opaque code plug-ins, Numscript invents a string
 * DSL. Recipes here are package-distributed, code-reviewed, versioned,
 * contract-tested TypeScript. Full rationale + take/reject matrix:
 * docs/posting-rules-design.md.
 *
 * Purity contract: every function member MUST be a pure, deterministic
 * function of its input — no IO, no Date.now(), no randomness. The test
 * kit's `assertDeterministic` enforces this by double evaluation.
 */

/** External document reference stamped on the journal entry. */
export interface RecipeSourceRef {
  sourceModel: string;
  sourceId: string;
}

export interface RecipePartner {
  partnerId: string;
  partnerType: 'customer' | 'supplier';
}

/** Foreign-currency audit trail for one leg. */
export interface RecipeFx {
  /** ISO 4217. */
  currency: string;
  exchangeRate: number;
  /** Original amount in the foreign currency's minor units. */
  foreignAmount: number;
}

/**
 * How a leg finds its GL account. Four modes — the exact set observed in
 * the requirements corpus (docs/posting-rules-design.md §3.3):
 *
 * - `slot`   — semantic chart alias ('ar', 'merchandise', 'vatOutput');
 *              resolved by the host's SlotResolver at evaluation time.
 *              Used by 100 % of corpus contracts.
 * - `route`  — item-derived code (payment-method tables, regex clearing
 *              lookups). The function returns a SLOT name resolved through
 *              the same SlotResolver, keeping routing tables chart-agnostic.
 * - `resolve`— nullable resolver for regime/rate-gated accounts (input
 *              VAT): `null` means the leg does NOT post and its amount
 *              FOLDS into the leg named by `foldInto` (the engine performs
 *              the fold and records it in the explain trace).
 * - `code`   — literal GL code escape hatch. Discouraged; traced loudly.
 */
export type AccountRef<TItem> =
  | { readonly slot: string }
  | { readonly route: (item: TItem) => string }
  | {
      readonly resolve: (item: TItem) => string | null;
      /** Leg id whose amount absorbs this leg's amount when resolve() is null. */
      readonly foldInto: string;
    }
  | { readonly code: (item: TItem) => string };

export interface LegRule<TInput, TItem = TInput> {
  /** Stable id — used for tracing, fold targeting, and extension points. */
  readonly id: string;
  readonly account: AccountRef<TItem>;
  readonly side: 'debit' | 'credit';
  /** Minor units (paisa/cents). Pure. */
  readonly amount: (item: TItem) => number;
  /**
   * Leg posts only when true. Default guard: `amount(item) > 0` — the
   * corpus's dominant conditional. A custom `when` REPLACES the default
   * (legs that must post at zero pass `() => true`).
   */
  readonly when?: ((item: TItem) => boolean) | undefined;
  readonly label: (item: TItem) => string;
  readonly partner?: ((item: TItem) => RecipePartner | undefined) | undefined;
  readonly maturityDate?: ((item: TItem) => Date | undefined) | undefined;
  readonly fx?: ((item: TItem) => RecipeFx | undefined) | undefined;
  /**
   * Group expansion — one physical leg per produced item (per-payment-
   * method aggregation legs, landed-cost clearing groups). When present,
   * every other member receives the ITEM, not the recipe input.
   */
  readonly expand?: ((input: TInput) => ReadonlyArray<TItem>) | undefined;
}

export interface PostingRecipe<TInput> {
  /** Registry key, namespaced by pack: 'commerce.sales.transaction'. */
  readonly name: string;
  /** Static, or input-derived (e.g. POS vs ECOM sales share one recipe). */
  readonly journalType: string | ((input: TInput) => string);
  /** MUST be a pure, deterministic function of the input. */
  readonly idempotencyKey: (input: TInput) => string;
  /**
   * Entry date, derived from the INPUT (never `new Date()` — purity).
   * Handlers pre-default optional dates before evaluation.
   */
  readonly date?: ((input: TInput) => Date) | undefined;
  readonly sourceRef?: ((input: TInput) => RecipeSourceRef | undefined) | undefined;
  readonly label: (input: TInput) => string;
  /** Static policy or input-derived (e.g. COGS: false when costMissing). */
  readonly autoPost: boolean | ((input: TInput) => boolean);
  /** Dual-representation events (branch transfers) derive the org per recipe. */
  readonly organizationId?: ((input: TInput) => string | undefined) | undefined;
  readonly metadata?: ((input: TInput) => Record<string, unknown> | undefined) | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous item types per leg — each LegRule pins its own TItem via its expand
  readonly legs: ReadonlyArray<LegRule<TInput, any>>;
}

/** Chart alias lookup — host/pack supplies it (activeCodes-style). */
export type SlotResolver = (slot: string) => string | undefined;

export interface EvaluateContext {
  slots: SlotResolver;
}

/** Per-leg provenance — "why did this account get hit". Always on. */
export interface LegExplain {
  legId: string;
  accountMode: 'slot' | 'route' | 'resolve' | 'code';
  slot?: string | undefined;
  resolvedCode: string;
  /** Result of the when-guard (default or custom). */
  conditionResult: boolean;
  /** Present when another leg's resolve() returned null and folded here. */
  folded?: { fromLegId: string; amount: number } | undefined;
}

export interface DraftLeg {
  legId: string;
  accountCode: string;
  side: 'debit' | 'credit';
  /** Minor units, post-fold. */
  amount: number;
  label: string;
  partner?: RecipePartner | undefined;
  maturityDate?: Date | undefined;
  fx?: RecipeFx | undefined;
  explain: LegExplain;
}

/**
 * Pure evaluation output. `skipped: true` (with zero legs) is the
 * intentional-no-op contract — recipes whose every leg conditions out
 * (zero-amount shift close, nothing to accrue) produce a skipped draft
 * rather than null, so callers get the key/name for logging without
 * null-branching.
 */
export interface PostingDraft {
  recipeName: string;
  journalType: string;
  idempotencyKey: string;
  date?: Date | undefined;
  label: string;
  autoPost: boolean;
  organizationId?: string | undefined;
  sourceRef?: RecipeSourceRef | undefined;
  metadata?: Record<string, unknown> | undefined;
  legs: DraftLeg[];
  totals: { debit: number; credit: number };
  skipped: boolean;
}

/** Σdebit ≠ Σcredit after folding — names the legs so the diff is readable. */
export class UnbalancedRecipeError extends Error {
  readonly code = 'POSTING_RECIPE_UNBALANCED';
  constructor(
    readonly recipeName: string,
    readonly totals: { debit: number; credit: number },
    readonly legs: ReadonlyArray<{ legId: string; side: string; amount: number }>,
  ) {
    super(
      `Posting recipe '${recipeName}' is unbalanced: debit ${totals.debit} ≠ credit ${totals.credit}. ` +
        `Legs: ${legs.map((l) => `${l.legId}(${l.side} ${l.amount})`).join(', ')}`,
    );
  }
}

export class UnknownSlotError extends Error {
  readonly code = 'POSTING_RECIPE_UNKNOWN_SLOT';
  constructor(
    readonly recipeName: string,
    readonly legId: string,
    readonly slot: string,
  ) {
    super(
      `Posting recipe '${recipeName}' leg '${legId}' references slot '${slot}' ` +
        `which the chart does not provide. Add the slot to the chart pack's alias map ` +
        `(fail-loud by design — never a silent default account).`,
    );
  }
}

export class DuplicateRecipeError extends Error {
  readonly code = 'POSTING_RECIPE_DUPLICATE';
  constructor(readonly recipeName: string) {
    super(
      `Posting recipe '${recipeName}' is already registered. ` +
        `Use registry.override('${recipeName}', recipe) for a deliberate host override.`,
    );
  }
}

/** foldInto names a leg id that does not exist in the recipe. */
export class UnknownFoldTargetError extends Error {
  readonly code = 'POSTING_RECIPE_UNKNOWN_FOLD_TARGET';
  constructor(
    readonly recipeName: string,
    readonly legId: string,
    readonly foldInto: string,
  ) {
    super(`Posting recipe '${recipeName}' leg '${legId}' folds into unknown leg '${foldInto}'.`);
  }
}
