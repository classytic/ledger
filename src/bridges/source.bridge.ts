/**
 * SourceBridge — host-implemented resolver for polymorphic external references.
 *
 * Ledger journal entries commonly carry a `reference`/`externalRef` pointing
 * at a source document that lives outside the ledger package — an Invoice,
 * Payment, Payroll Run, Stripe Charge, ERP voucher, etc. Storing these as
 * opaque `String + sourceModel` (per PACKAGE_RULES §7) keeps the ledger
 * transport-agnostic: the same schema works whether the source lives in the
 * same Mongo, a different Mongo, Postgres, or an external REST API.
 *
 * Hosts implement `SourceBridge` to hydrate those refs when building
 * enriched views (partner ledger with invoice details, audit trail with
 * payment metadata, reconciliation UI with source documents, etc.).
 *
 * All methods are optional. Features that need resolution degrade gracefully
 * when a bridge is not provided.
 */

export interface SourceRef {
  sourceId: string;
  sourceModel: string;
}

export interface SourceBridgeContext {
  organizationId?: unknown;
  actorId?: unknown;
  [key: string]: unknown;
}

export interface SourceBridge {
  /**
   * Resolve a single external reference.
   *
   * Return `null` when the source cannot be found (deleted, permission
   * denied, wrong model). Do not throw for missing sources — callers
   * expect `null` for graceful degradation.
   */
  resolve?(
    sourceId: string,
    sourceModel: string,
    ctx: SourceBridgeContext,
  ): Promise<unknown | null>;

  /**
   * Batch resolver — avoids N+1 round-trips when enriching a list.
   * Key the returned map by `sourceId`. Missing sources may be omitted or
   * mapped to `null` at the implementer's discretion.
   */
  resolveMany?(
    refs: ReadonlyArray<SourceRef>,
    ctx: SourceBridgeContext,
  ): Promise<Map<string, unknown>>;
}
