export type {
  EntryReversedNotification,
  NotificationBridge,
  NotificationBridgeContext,
  PeriodLockedNotification,
  ReconciliationMismatchNotification,
} from './notification.bridge.js';
export type { SourceBridge, SourceBridgeContext, SourceRef } from './source.bridge.js';

import type { NotificationBridge } from './notification.bridge.js';
import type { SourceBridge } from './source.bridge.js';

/** Collected bridges exposed as `engine.bridges`. */
export interface LedgerBridges {
  source?: SourceBridge;
  notification?: NotificationBridge;
}
