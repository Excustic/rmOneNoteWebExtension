import { ext } from '../shared/browser';
import {
  getPreferences,
  onSyncStorageChanged,
  type UserPreferences,
} from '../storage/preferences';

export const AUTO_SYNC_ALARM_NAME = 'rmOneNoteAutoSync';

/**
 * Configures or clears the `browser.alarms` periodic sync timer to match `UserPreferences`.
 */
export async function syncAutoSyncAlarmWithPreferences(
  prefsOverride?: UserPreferences,
): Promise<void> {
  const prefs = prefsOverride ?? (await getPreferences());

  if (!prefs.autoSync) {
    await ext.alarms.clear(AUTO_SYNC_ALARM_NAME);
    return;
  }

  const periodInMinutes = Math.max(1, Math.round(prefs.syncIntervalMinutes));
  ext.alarms.create(AUTO_SYNC_ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
}

/**
 * Registers top-level MV3 listeners for `browser.alarms.onAlarm` and `storage.sync`
 * preference updates.
 */
export function registerAutoSyncAlarmListeners(
  onAlarmTriggered: () => Promise<void> | void,
): () => void {
  const handleAlarm = (alarm: { name: string }) => {
    if (alarm.name === AUTO_SYNC_ALARM_NAME) {
      void Promise.resolve(onAlarmTriggered()).catch((err) => {
        console.error('[rmOneNote] Scheduled alarm sync cycle failed:', err);
      });
    }
  };

  ext.alarms.onAlarm.addListener(handleAlarm);

  const unsubscribeStorage = onSyncStorageChanged((changes) => {
    if ('prefs' in changes) {
      void syncAutoSyncAlarmWithPreferences().catch((err) => {
        console.error('[rmOneNote] Failed to update auto-sync alarm after preference change:', err);
      });
    }
  });

  return () => {
    ext.alarms.onAlarm.removeListener(handleAlarm);
    unsubscribeStorage();
  };
}

