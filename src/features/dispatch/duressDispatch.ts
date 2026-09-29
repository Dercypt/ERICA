import { getContacts } from '../contacts/contactsStorage';
import { getCurrentLocation } from '../location/locationService';
import { dispatchEmergencySms } from './smsDispatch';
import { appendHistoryEntry } from '../history/historyStorage';

export interface DuressSosResult {
  triggered: boolean;
  recipients: string[];
  reason?: string;
}

/**
 * Triggers a stealth, silent SOS ping in the background when the user enters the Duress PIN.
 *
 * CRITICAL THREAT-MODEL GUARDS:
 * 1. Stealth execution: No countdown delay, no sirens/audio cues, and no Android foreground notifications.
 * 2. Does NOT alert the adversary that an emergency ping was dispatched.
 * 3. Safely accesses encrypted contacts via scoped master key operations, immediately wiping buffers from memory.
 * 4. Logs a discrete entry in the encrypted emergency history log.
 */
export async function triggerDuressSilentSos(): Promise<DuressSosResult> {
  try {
    const contacts = await getContacts();
    if (contacts.length === 0) {
      return { triggered: false, recipients: [], reason: 'No contacts configured' };
    }

    // Acquire current GPS location if accessible
    const location = await getCurrentLocation().catch(() => null);

    const dispatchRes = await dispatchEmergencySms({
      contacts,
      location,
      triggerSource: 'Duress PIN (Silent SOS)',
    });

    if (dispatchRes.attempted) {
      await appendHistoryEntry({
        sessionId: `duress_${Date.now()}`,
        triggerSource: 'Duress PIN (Silent SOS)',
        startedAt: Date.now(),
        resolvedAt: null,
        locationCaptured: location !== null,
      }).catch((err) => {
        console.warn('[duressDispatch] Failed to append history entry:', err);
      });
    }

    return {
      triggered: dispatchRes.attempted,
      recipients: dispatchRes.recipients,
    };
  } catch (err) {
    console.warn('[duressDispatch] Error executing silent duress SOS:', err);
    return {
      triggered: false,
      recipients: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
