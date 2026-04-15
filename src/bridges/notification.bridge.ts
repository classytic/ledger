/**
 * NotificationBridge — host-implemented delivery for ledger-originated alerts.
 *
 * The ledger generates operational alerts that hosts may want to route to
 * email, Slack, in-app notifications, or an audit/compliance system:
 *
 *   - `periodLocked` — a fiscal period was locked (audit sign-off)
 *   - `periodUnlocked` — a locked period was re-opened (requires elevated role)
 *   - `entryReversed` — a posted entry was reversed (accounting correction)
 *   - `reconciliationMismatch` — match debit/credit totals differ (FX gain/loss)
 *
 * This is deliberately thin — richer integrations should subscribe to the
 * EventTransport (§11-14) and route via their own notification stack.
 * NotificationBridge exists for hosts that want a direct callback without
 * owning an event bus.
 *
 * All methods are optional. Skip the bridge entirely if the host uses events.
 */

export interface NotificationBridgeContext {
  organizationId?: unknown;
  actorId?: unknown;
  correlationId?: string;
}

export interface PeriodLockedNotification {
  periodId: unknown;
  startDate: Date;
  endDate: Date;
  lockedBy?: unknown;
}

export interface EntryReversedNotification {
  originalEntryId: unknown;
  reversalEntryId: unknown;
  reversalDate: Date;
  reversedBy?: unknown;
  reason?: string;
}

export interface ReconciliationMismatchNotification {
  matchingNumber: string;
  account: unknown;
  debitTotal: number;
  creditTotal: number;
  difference: number;
  currency: string | null;
}

export interface NotificationBridge {
  onPeriodLocked?(payload: PeriodLockedNotification, ctx: NotificationBridgeContext): Promise<void>;

  onPeriodUnlocked?(
    payload: PeriodLockedNotification,
    ctx: NotificationBridgeContext,
  ): Promise<void>;

  onEntryReversed?(
    payload: EntryReversedNotification,
    ctx: NotificationBridgeContext,
  ): Promise<void>;

  onReconciliationMismatch?(
    payload: ReconciliationMismatchNotification,
    ctx: NotificationBridgeContext,
  ): Promise<void>;
}
