import { sendSilentSms, isAvailableAsync } from '../../../modules/silent-sms';
import type { Contact } from '../contacts/contactsStorage';
import type { LocationResult } from '../location/locationService';
import { mapsLinkFor } from '../location/locationService';
import { getSettings } from '../settings/settingsStorage';
import { enqueueAndDispatch, isSmsAvailable } from './queueProcessor';

export interface DispatchResult {
  attempted: boolean;
  recipients: string[];
}

interface DispatchParams {
  contacts: Contact[];
  location: LocationResult | null;
  triggerSource: string;
}

export interface SmsComposerResult {
  result: 'sent' | 'cancelled' | 'unknown';
}

let customComposerSender: ((recipients: string[], message: string) => Promise<SmsComposerResult>) | null = null;

/**
 * Configure custom SMS composer implementation (useful for iOS companion testing).
 */
export function setCustomComposerSender(
  sender: ((recipients: string[], message: string) => Promise<SmsComposerResult>) | null
): void {
  customComposerSender = sender;
}

/**
 * Phase 2 direct carrier SMS dispatch using native SilentSms module (android.telephony.SmsManager)
 * backed by persistent SQLite outbox queue, exponential backoff retries, and NetInfo connectivity flush.
 *
 * Phase 8 / Companion fallback: When running on iOS where background programmatic SMS is forbidden
 * by platform policies, opens the capability-honest native SMS composer prefilled with live location.
 */
export async function dispatchEmergencySms({ contacts, location, triggerSource }: DispatchParams): Promise<DispatchResult> {
  const recipients = contacts.map((c) => c.phoneNumber);
  if (recipients.length === 0) {
    return { attempted: false, recipients };
  }

  const settings = await getSettings();
  const who = settings.userName.trim() || 'The user';
  const body = settings.customMessage.trim() || `${who} may be in danger.`;
  const locationLine = location
    ? `Location: ${mapsLinkFor(location)}\nAccuracy: ${location.accuracy ?? 'unknown'} meters`
    : 'Location: unavailable';

  const message = [
    'EMERGENCY ALERT',
    '',
    body,
    '',
    `Triggered via: ${triggerSource}`,
    locationLine,
    '',
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  const silentAvailable = await isSmsAvailable();
  if (silentAvailable) {
    const ceilingMs = settings.retryCeilingSeconds ? settings.retryCeilingSeconds * 1000 : undefined;
    await enqueueAndDispatch(recipients, message, { ceilingMs });
    return { attempted: true, recipients };
  }

  // Capability-honest iOS companion flow fallback:
  try {
    if (customComposerSender) {
      const res = await customComposerSender(recipients, message);
      return { attempted: res.result === 'sent', recipients };
    }
    const SMS = await import('expo-sms');
    const isComposerAvailable = await SMS.isAvailableAsync();
    if (isComposerAvailable) {
      const composerResult = await SMS.sendSMSAsync(recipients, message);
      return { attempted: composerResult.result === 'sent', recipients };
    }
  } catch (err) {
    console.warn('[smsDispatch] Fallback SMS composer error:', err);
  }

  return { attempted: false, recipients };
}

export async function dispatchSafeSms(contacts: Contact[]): Promise<DispatchResult> {
  const recipients = contacts.map((c) => c.phoneNumber);
  if (recipients.length === 0) {
    return { attempted: false, recipients };
  }

  const message = 'EMERGENCY RESOLVED\n\nThe user has marked themselves safe.';
  const silentAvailable = await isSmsAvailable();
  if (silentAvailable) {
    const settings = await getSettings();
    const ceilingMs = settings.retryCeilingSeconds ? settings.retryCeilingSeconds * 1000 : undefined;
    await enqueueAndDispatch(
      recipients,
      message,
      { ceilingMs }
    );
    return { attempted: true, recipients };
  }

  // Capability-honest iOS companion flow fallback:
  try {
    if (customComposerSender) {
      const res = await customComposerSender(recipients, message);
      return { attempted: res.result === 'sent', recipients };
    }
    const SMS = await import('expo-sms');
    const isComposerAvailable = await SMS.isAvailableAsync();
    if (isComposerAvailable) {
      const composerResult = await SMS.sendSMSAsync(recipients, message);
      return { attempted: composerResult.result === 'sent', recipients };
    }
  } catch (err) {
    console.warn('[smsDispatch] Fallback safe SMS composer error:', err);
  }

  return { attempted: false, recipients };
}

export { sendSilentSms, isAvailableAsync };

