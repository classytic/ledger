# Posting Rules — a typed, package-composable subledger accounting engine

**Status:** DESIGN (2026-07-17) · research-backed · implementation phases at end
**Owners:** `@classytic/ledger` (kernel evaluator) · `@classytic/ledger-bd` (BD recipe pack) · `@classytic/arc-accounting` (registration + event harness integration) · hosts (slots + overrides)

---

## 1. Problem

Every "business event → journal entries" rule in the platform today is a hand-written
TypeScript function (be-prod: 18 contract files, ~35 posting functions, ~3k LOC).
The rules are correct and well-tested, but they are a **jurisdiction and vertical
fork-surface**: a US/CA deployment means re-writing 18 functions; a new vertical
(manufacturing WIP, hospitality folios) means more hand-rolled functions with no
shared structure, no balance guarantees, no reversal symmetry, and no way to answer
"why did this account get hit?"

## 2. Research base

Three studies inform this design (full reports in the 2026-07-17 session task logs;
key findings inlined below):

1. **Requirements corpus** — every leg, amount formula, conditional, idempotency
   template, and metadata stamp across be-prod's 18 contracts, with a feature
   frequency table and the five hardest cases (import-clearance tax stack,
   landed-cost regex routing, VDS chained conditionals, COD lifecycle triple,
   rate/regime-gated tax accounts). v1 scope below covers 100 % of observed usage.
2. **Odoo source study** (vendored at `packages/odoo`) — the genuinely declarative
   pieces worth stealing (tax **repartition lines**: factor × account × tags with
   separate invoice/refund sets; **fiscal positions**: conditional account/tax
   remaps as data; hierarchical property-based account derivation) and the failure
   modes to reject (the `account.move` god-model with cascading computes and
   context-flag sync; a 400-line procedural tax engine that forces Python
   subclassing for any conditional behavior; stateful chart-template instantiation).
3. **Incumbents survey** — Oracle SLA ([rule model](https://docs.oracle.com/cd/E15586_01/fusionapps.1111/e20375/F569960AN52F30.htm):
   event classes → journal entry rule sets → journal line rules + account
   derivation rules + mapping sets; [implementation guide](https://docs.oracle.com/cd/E26401_01/doc.122/e48771/index.htm);
   practitioner reality: powerful but [diagnostics tank performance](https://docs.oracle.com/en/cloud/saas/financials/26a/ocuar/diagnose-subledger-accounting-event-data.html)
   and Create Accounting needs [tuning guides of its own](https://docs.oracle.com/en/cloud/saas/financials/25d/faisl/tips-to-improve-accounting-performance.html)),
   SAP ([document splitting](https://help.sap.com/docs/SAP_S4HANA_CLOUD/0fa84c9d9c634132b7c4abb9ffdd8f06/4911c9cc2a934a18e10000000a42189b.html),
   [OBYC account determination with **predefined, unchangeable** transaction keys](https://controlling.erpcorp.com/sap-controlling-blog/fundamentals-of-mm-fi-account-determination),
   silent default-value degradation), NetSuite ([SuiteGL Custom GL Lines plug-ins](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_3987870163.html)
   — imperative code mutating GL impact at posting time, i.e. exactly what our
   hand-written contracts are), and the modern rules-as-data ledgers
   ([Formance Numscript](https://github.com/formancehq/numscript): readability /
   correctness / finiteness; [Modern Treasury on immutability](https://www.moderntreasury.com/journal/enforcing-immutability-in-your-double-entry-ledger);
   [Uber's GAAP-per-event ledgers](https://www.uber.com/blog/ubers-finance-computation-platform/),
   [Airbnb's double-entry reporting](https://medium.com/airbnb-engineering/tracking-the-money-scaling-financial-reporting-at-airbnb-6d742b80f040)).

### Take / reject matrix

| System | Take | Reject |
|---|---|---|
| Oracle SLA | Layered rule model (event → rule set → line rules + account rules + conditions); draft-vs-final accounting; supporting references; multi-representation | Config sprawl across setup screens; stringly-typed sources; debugging that requires a slow diagnostics mode; runtime rule resolution opacity |
| SAP | Universal-journal single-table with dimensions (our ledger already is one); zero-balancing per dimension (→ dual-org transfers) | Closed vocabulary of predefined transaction keys; silent default-account fallbacks |
| Odoo | Repartition-line split model; fiscal-position conditional remaps; hierarchical account derivation; separate invoice/refund rule sets; tag-based tax reporting (→ Mushak mapping) | God-model synchronization; procedural tax engine; context flags; UI-first rules that resist versioning/review |
| NetSuite SuiteGL | (Honest niche: escape hatch exists) | Code plug-ins as the *primary* rule mechanism — no structure, no balance guarantees, no introspection |
| Numscript / MT / Uber | Recipes readable by accountants; correctness as engine invariant (balance, no money creation); finiteness; immutability; idempotency as first-class | String DSL parsed at runtime (we have a type system); ledger-only scope (no account derivation / tax story) |

## 3. The design

### 3.1 Core decision: typed recipe objects, not an expression AST and not a string DSL

Rules are **TypeScript data objects whose leaves are pure functions**, distributed
as npm packages. The *structure* (legs, sides, account references, conditions,
partner stamping, idempotency, journal type) is declarative and introspectable —
that is what the engine validates, traces, reverses, and documents. The *amounts*
are pure typed functions of the input — full inference, compile-time checking,
trivially unit-testable, no expression-language runtime.

This is the deliberate divergence from every incumbent: Oracle/SAP/Odoo put rules
in runtime configuration (sprawl, opacity, upgrade fragility); NetSuite puts them
in opaque code; Numscript invents a string language. Our market is
**package-distributed, code-reviewed, versioned, contract-tested jurisdiction
packs** — TypeScript already is the ideal typed, reviewable representation, and
the corpus shows zero demand for end-user rule editing.

### 3.2 Recipe model (kernel: `@classytic/ledger` → `src/posting-rules/`)

```ts
export interface PostingRecipe<TInput> {
  /** Registry key, e.g. 'commerce.sales.transaction'. Namespaced by pack. */
  name: string;
  journalType: string;
  /** MUST be a pure, deterministic function of the input (engine contract-tests this). */
  idempotencyKey: (input: TInput) => string;
  sourceRef?: (input: TInput) => { sourceModel: string; sourceId: string } | undefined;
  label: (input: TInput) => string;
  /** Static policy or input-derived (e.g. COGS: false when costMissing). */
  autoPost: boolean | ((input: TInput) => boolean);
  /** Dual-representation events (branch transfers) override the org per evaluation. */
  organizationId?: (input: TInput) => string | undefined;
  metadata?: (input: TInput) => Record<string, unknown> | undefined;
  legs: ReadonlyArray<LegRule<TInput>>;
}

export interface LegRule<TInput, TItem = TInput> {
  /** Stable id for tracing + extension targeting, e.g. 'ar', 'vat-output'. */
  id: string;
  account: AccountRef<TItem>;
  side: 'debit' | 'credit';
  /** Paisa/minor units. Pure. */
  amount: (item: TItem) => number;
  /** Leg posts only when true (default: amount > 0 — the corpus's dominant guard). */
  when?: (item: TItem) => boolean;
  label: (item: TItem) => string;
  partner?: (item: TItem) => { partnerId: string; partnerType: 'customer' | 'supplier' } | undefined;
  maturityDate?: (item: TItem) => Date | undefined;
  fx?: (item: TItem) => { currency: string; exchangeRate: number; foreignAmount: number } | undefined;
  /**
   * Group expansion — one physical leg per produced item (per-payment-method
   * POS aggregation legs, landed-cost clearing groups). The corpus's patterns
   * 3 and 6.
   */
  expand?: (input: TInput) => ReadonlyArray<TItem>;
}
```

### 3.3 Account references — the four resolution modes the corpus observed

```ts
export type AccountRef<TItem> =
  | { slot: string }                                        // 100 % of contracts: 'ar', 'merchandise', 'vatOutput'
  | { route: (item: TItem) => string }                      // payment-method routing (17 %), regex clearing tables (6 %)
  | { resolve: (item: TItem) => string | null;              // regime/rate-gated tax accounts (22 %) — null = fold
      foldInto: string /* leg id whose amount absorbs this leg's amount */ }
  | { code: (item: TItem) => string };                      // escape hatch: literal code (discouraged, traced loudly)
```

- **Slots** are semantic keys (`ar`, `grIrClearing`, `restockingFeeIncome`, ~35 in
  the corpus). The **chart pack** (existing `country-pack.ts` seam / `activeCodes`)
  maps slot → GL code; the engine caches code → account-id. Packs **declare the
  slots their recipes require**; the registry validates the chart provides them at
  boot — fail-loud, never SAP-style silent defaults.
- **`resolve` + `foldInto`** encodes the corpus's hardest recurring pattern
  precisely: regime-gated input VAT that either posts to its own account or folds
  into the inventory leg's amount. The engine performs the fold — recipes never
  hand-compute "net + maybe-absorbed-tax" again.

### 3.4 Engine invariants and facilities (the "beat Oracle" list)

1. **Pure evaluation, single pass.** `evaluate(recipe, input, resolverCtx) →
   PostingDraft` performs no IO. Odoo's sync problem and SLA's opacity are
   eliminated at the type level: same input, same draft, always.
2. **Balance enforced.** Σdebit = Σcredit or a typed `UnbalancedRecipeError`
   naming the legs and amounts. Correctness is an engine invariant, not a code
   review hope (Numscript's principle).
3. **Explain mode — free, always on.** Every draft leg carries provenance:
   `{ legId, accountSlot → code → accountId, conditionResult, amountValue,
   foldedFrom? }`. Answering "why did this account get hit" is a property of the
   data structure, not a slow diagnostics run (Oracle's documented pain, inverted).
4. **Draft vs post.** Drafts are accountant-reviewable JSON; posting is the
   existing idempotent `createPosting`/engine path (ledger's race-safe
   `idempotencyKey` dedup stays the single idempotency mechanism).
5. **Reversal by derivation.** `reversalOf(recipe, { keySuffix, label })` flips
   sides mechanically — the corpus's five hand-written reversal contracts become
   symmetric **by construction** and can never drift from their originals.
6. **Deterministic idempotency, contract-tested.** The test kit evaluates every
   registered recipe twice and asserts identical keys and drafts (no
   `Date.now()`, no randomness — enforced, not documented).
7. **Registry + strangler overrides.** `PostingRuleRegistry.register(recipe)` /
   `.override(name, recipe)`; packs contribute batches; hosts override single
   recipes. Boot-time sweep reports unresolvable slots and duplicate names.
8. **Test kit.** `expectRecipe(recipe).given(input).toPost([{ slot: 'ar', debit: 98_00 }, …])`
   — per-pack contract floors in the arc-testkit tradition; plus golden-draft
   snapshots for the migration (old contract output ≡ new recipe draft on the
   same corpus of fixture inputs — the migration gate).
9. **Tax stays port-shaped.** Resolvers (`inputVatAccount`, `computeWithholding`,
   `computeImportStack`) COMPUTE; recipes PLACE. Confirmed by the corpus: 0 % of
   legs need a percent operation — jurisdiction math lives behind the existing
   `resolverCtx` ports, exactly like arc-bd-tax's source-bridge doctrine.
10. **Composition (extension points) — designed now, shipped with the second
    user.** A pack may export `RecipeExtension`s targeting a base recipe's leg
    ids: contribute legs, wrap amounts (`payable = base − withheld`). This is the
    long-term moat (universal commerce recipes + thin jurisdiction overlays —
    what Odoo's fiscal positions gesture at, typed). **v1 ships BD recipes
    wholesale in `ledger-bd`** — no speculative machinery before a second
    jurisdiction exists; the leg-id + fold mechanics above are the designed
    seam it will hang from.

### 3.5 Package layout & ownership

| Package | Owns |
|---|---|
| `@classytic/ledger` `src/posting-rules/` | Recipe/LegRule/AccountRef types, evaluator, balance/idempotency invariants, explain tracing, `reversalOf`, registry, test kit |
| `@classytic/ledger-bd` | The BD recipe pack: all 18 migrated contracts as recipes + slot-requirements declaration (rides the existing chart/tax pack — `COUNTRY_PACK` selects recipes the same way it selects the chart today) |
| `@classytic/arc-accounting` | Registry wiring into the module; `createPosting` gains `postRecipe(name, input)`; posting-subscriber harness handlers shrink to `build → { recipe, input }` |
| Hosts (be-prod) | Chart slot mapping (existing `activeCodes`), resolver ports (existing), per-recipe overrides only when policy genuinely diverges |

### 3.6 v1 scope (= 100 % of corpus usage, nothing speculative)

Leg conditions (default amount>0 + custom predicates) · slot/route/resolve+fold/code
account refs · partner + maturity + FX stamping · metadata + idempotency + label
templates as typed fns · autoPost static/derived · group expansion · dual-org
evaluation · derived reversals · registry + overrides + boot validation · explain
drafts · test kit. **Out (caller's job, per corpus):** tax math, business-day
arithmetic, cross-entity reads (recipes are pure input → draft; violations in two
current contracts get their reads hoisted into the event handler during migration).

## 4. Migration plan (phased, each phase gated by the golden-draft suite)

1. **Kernel** — `ledger` posting-rules module + evaluator + test kit (+ golden-draft
   harness). Publish-ready behind the existing ledger version line.
2. **BD pack** — migrate the 18 contracts to recipes in `ledger-bd`, one structural
   pattern at a time (simple pairs → tax-split → aggregation → dual-org → the
   hardest five last), each recipe pinned by golden drafts against the legacy
   contract's outputs on shared fixtures.
3. **arc-accounting** — `postRecipe` + registry wiring; posting-subscriber handlers
   return `{ recipe, input }`; explain drafts exposed on an admin preview route
   (draft accounting, SLA-style, for finance review).
4. **be-prod adoption** — contracts directory deleted; host keeps slots, resolvers,
   and (if any) overrides. Full-suite gate.
5. **Later:** extension-point layering when jurisdiction #2 (US/CA — `ledger-ca`
   GIFI chart already exists) lands; UI draft-preview surfaces; Mushak tag mapping
   via leg tags (Odoo's tax-grid idea).

## 5. Why this beats the incumbents

- **vs Oracle SLA:** same expressive layering, but rules are typed, versioned,
  diffable npm packages with compile-time account checking and always-on explain
  tracing — no setup sprawl, no diagnostics mode, no upgrade fragility.
- **vs SAP:** open slot vocabulary instead of frozen transaction keys; fail-loud
  slot validation instead of silent default degradation.
- **vs Odoo:** repartition-grade declarativeness for **every** posting (not just
  tax), single-pass pure evaluation instead of god-model sync, packs that install
  like libraries instead of stateful template instantiation.
- **vs NetSuite:** structure, balance guarantees, and introspection instead of
  imperative GL-impact plug-ins.
- **vs Numscript/MT:** their correctness discipline with a real type system,
  account derivation, tax ports, and jurisdiction packaging they don't attempt.
