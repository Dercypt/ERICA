import { Platform } from 'react-native';
import { sendSilentSms, isAvailableAsync } from '../../../modules/silent-sms';
import type { Contact } from '../contacts/contactsStorage';
import type { LocationResult } from '../location/locationService';
import { getSettings } from '../settings/settingsStorage';
import { enqueueAndDispatch, isSmsAvailable } from './queueProcessor';

export interface DispatchResult {
  attempted: boolean;
  recipients: string[];
  /**
   * False when the alert was queued on Android but SMS cannot be sent right now
   * (SEND_SMS not granted, no telephony). The outbox retries until it can go out.
   */
  smsAvailable?: boolean;
}

async function checkSmsAvailable(): Promise<boolean> {
  try {
    return await isSmsAvailable();
  } catch {
    return false;
  }
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
 * Builds the alert as one plain-text SMS.
 *
 * - No URL: Philippine carriers (Globe, Smart) silently drop person-to-person SMS containing
 *   links, so a maps link made the alert vanish while the link-free "resolved" text arrived.
 *   Plain coordinates still paste straight into any maps app.
 * - GSM-7 characters only and no ISO timestamp, so the default text fits one 160-character
 *   segment instead of a multipart message (a non-GSM character like "±" would cut the limit
 *   to 70). A long custom message can still need several segments.
 */
export function composeEmergencyMessage(
  body: string,
  location: LocationResult | null,
  triggerSource: string,
  now: Date
): string {
  const where = location
    ? `Location: ${location.latitude.toFixed(5)},${location.longitude.toFixed(5)}` +
      (location.accuracy != null ? ` (accuracy ${Math.round(location.accuracy)}m)` : '')
    : 'Location: unavailable';
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `EMERGENCY ALERT: ${body} ${where}. Triggered via: ${triggerSource}. ${time}`;
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
  const message = composeEmergencyMessage(body, location, triggerSource, new Date());

  const silentAvailable = await checkSmsAvailable();
  // On Android the alert is always queued, even when SMS is unavailable right now: the
  // composer needs a tap, and dropping the alert would break the non-loss guarantee
  // (LAWS.md Law 2). The outbox keeps retrying until permission or signal returns.
  if (silentAvailable || Platform.OS === 'android') {
    const ceilingMs = settings.retryCeilingSeconds ? settings.retryCeilingSeconds * 1000 : undefined;
    await enqueueAndDispatch(recipients, message, { ceilingMs });
    return { attempted: true, recipients, smsAvailable: silentAvailable };
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
  const silentAvailable = await checkSmsAvailable();
  if (silentAvailable || Platform.OS === 'android') {
    const settings = await getSettings();
    const ceilingMs = settings.retryCeilingSeconds ? settings.retryCeilingSeconds * 1000 : undefined;
    await enqueueAndDispatch(
      recipients,
      message,
      { ceilingMs }
    );
    return { attempted: true, recipients, smsAvailable: silentAvailable };
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

