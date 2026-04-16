export type { ExchangeRateBridge } from './exchange-rate.bridge.js';
export type {
  EntryReversedNotification,
  NotificationBridge,
  NotificationBridgeContext,
  PeriodLockedNotification,
  ReconciliationMismatchNotification,
} from './notification.bridge.js';
export type { SourceBridge, SourceBridgeContext, SourceRef } from './source.bridge.js';

import type { ExchangeRateBridge } from './exchange-rate.bridge.js';
import type { NotificationBridge } from './notification.bridge.js';
import type { SourceBridge } from './source.bridge.js';

/** Collected bridges exposed as `engine.bridges`. All optional per PACKAGE_RULES §23. */
export interface LedgerBridges {
  source?: SourceBridge;
  notification?: NotificationBridge;
  exchangeRate?: ExchangeRateBridge;
}
