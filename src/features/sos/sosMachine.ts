import { setup, assign, fromPromise, fromCallback, createActor } from 'xstate';
import { useSelector } from '@xstate/react';
import { getContacts } from '../contacts/contactsStorage';
import { getSettings } from '../settings/settingsStorage';
import { getCurrentLocation, type LocationResult } from '../location/locationService';
import { dispatchEmergencySms, dispatchSafeSms } from '../dispatch/smsDispatch';
import { appendHistoryEntry, resolveHistoryEntry } from '../history/historyStorage';
import {
  startEmergencyForegroundService,
  stopEmergencyForegroundService,
  updateEmergencyNotification,
  acquireEmergencyWakeLock,
  releaseEmergencyWakeLock,
} from '../../../modules/foreground-service';

export interface SosContext {
  triggerSource: string;
  countdownTotal: number;
  secondsRemaining: number;
  startedAt: number | null;
  sessionId: string | null;
  location: LocationResult | null;
  lastError: string | null;
}

export type SosEvent =
  | { type: 'TRIGGER'; source?: string }
  | { type: 'CANCEL' }
  | { type: 'TICK' }
  | { type: 'MARK_SAFE' }
  | { type: 'DISMISS' }
  | { type: 'SETTINGS_UPDATED'; countdownSeconds: number };

const initialContext: SosContext = {
  triggerSource: 'Manual Button',
  countdownTotal: 10,
  secondsRemaining: 10,
  startedAt: null,
  sessionId: null,
  location: null,
  lastError: null,
};

// Ticks once a second while armed. A real countdown, not a fixed 10s
// constant — SOS-alerter hardcoded this despite exposing a "configurable"
// field for it.
const countdownTicker = fromCallback(({ sendBack }) => {
  const id = setInterval(() => sendBack({ type: 'TICK' }), 1000);
  return () => clearInterval(id);
});

const loadSettings = fromPromise(async () => getSettings());

const dispatchEmergency = fromPromise(async ({ input }: { input: { context: SosContext } }) => {
  const { context } = input;

  // Defensive wrap around contact decryption (Non-Negotiable Safety Law)
  let contacts: any[] = [];
  let contactDecryptionFailed = false;

  try {
    contacts = await getContacts();
  } catch (err) {
    console.warn('[sosMachine] Defensive fallback: contact decryption failed (e.g. lost key):', err);
    contactDecryptionFailed = true;
  }

  // Acquire live GPS coordinates (must proceed regardless of contact decryption failure)
  let location: LocationResult | null = null;
  try {
    location = await getCurrentLocation();
  } catch (locErr) {
    console.warn('[sosMachine] Failed to acquire GPS coordinates:', locErr);
  }

  if (contactDecryptionFailed) {
    // Non-Negotiable Safety Law: Never crash or abort emergency when vault is locked/corrupted.
    // Acquire live GPS coordinates, maintain emergency state, and display verified guidance:
    // "Contacts unavailable (vault locked) — Call Emergency Services (911)"
    try {
      await appendHistoryEntry({
        sessionId: context.sessionId as string,
        triggerSource: context.triggerSource,
        startedAt: context.startedAt as number,
        resolvedAt: null,
        locationCaptured: location !== null,
      });
    } catch {
      // Emergency history logging failure must never abort emergency
    }

    const fallbackError = new Error(
      'Contacts unavailable (vault locked) — Call Emergency Services (911)'
    );
    (fallbackError as any).location = location;
    throw fallbackError;
  }

  const result = await dispatchEmergencySms({ contacts, location, triggerSource: context.triggerSource });
  if (!result.attempted) {
    if (contacts.length === 0) {
      throw new Error('No trusted contacts configured. Please add contacts in the Contacts tab first.');
    }
    throw new Error('SMS service is unavailable on this device.');
  }

  await appendHistoryEntry({
    sessionId: context.sessionId as string,
    triggerSource: context.triggerSource,
    startedAt: context.startedAt as number,
    resolvedAt: null,
    locationCaptured: location !== null,
  });

  return { location };
});

const dispatchSafe = fromPromise(async ({ input }: { input: { context: SosContext } }) => {
  const { context } = input;
  let contacts: any[] = [];
  try {
    contacts = await getContacts();
  } catch (err) {
    console.warn('[sosMachine] Defensive fallback in dispatchSafe: contact decryption failed:', err);
  }

  if (contacts.length > 0) {
    try {
      await dispatchSafeSms(contacts);
    } catch (smsErr) {
      console.warn('[sosMachine] Safe SMS dispatch error:', smsErr);
    }
  }

  if (context.sessionId) {
    try {
      await resolveHistoryEntry(context.sessionId, Date.now());
    } catch {}
  }
});

export const sosMachine = setup({
  types: {} as {
    context: SosContext;
    events: SosEvent;
  },
  actors: { countdownTicker, loadSettings, dispatchEmergency, dispatchSafe },
  guards: {
    countdownFinished: ({ context }: { context: SosContext }) => context.secondsRemaining <= 1,
  },
  actions: {
    startCountdownService: () => {
      startEmergencyForegroundService({
        title: 'EMERGENCY ARMED',
        message: 'Countdown in progress. Tap I\'M SAFE to cancel.',
      }).catch((err) => console.warn('[sosMachine] startCountdownService error:', err));
    },
    startDispatchingService: () => {
      startEmergencyForegroundService({
        title: 'EMERGENCY DISPATCHING',
        message: 'Acquiring GPS and dispatching alert SMS...',
      }).catch((err) => console.warn('[sosMachine] startDispatchingService error:', err));
    },
    updateActiveNotification: () => {
      updateEmergencyNotification(
        'EMERGENCY ACTIVE',
        'Contacts alerted. Tap I\'M SAFE to stand down.'
      ).catch((err) => console.warn('[sosMachine] updateActiveNotification error:', err));
    },
    stopService: () => {
      stopEmergencyForegroundService().catch((err) =>
        console.warn('[sosMachine] stopService error:', err)
      );
    },
    acquireWakeLock: () => {
      acquireEmergencyWakeLock().catch((err) =>
        console.warn('[sosMachine] acquireWakeLock error:', err)
      );
    },
    releaseWakeLock: () => {
      releaseEmergencyWakeLock().catch((err) =>
        console.warn('[sosMachine] releaseWakeLock error:', err)
      );
    },
  },
}).createMachine({
  id: 'sos',
  context: initialContext,
  initial: 'idle',
  states: {
    idle: {
      entry: ['stopService', 'releaseWakeLock'],
      invoke: {
        src: 'loadSettings',
        onDone: {
          actions: assign(({ event }) => ({
            countdownTotal: event.output.countdownSeconds,
            secondsRemaining: event.output.countdownSeconds,
          })),
        },
      },
      on: {
        SETTINGS_UPDATED: {
          actions: assign(({ event }) => ({
            countdownTotal: event.countdownSeconds,
            secondsRemaining: event.countdownSeconds,
          })),
        },
        TRIGGER: {
          target: 'countdown',
          actions: assign(({ context, event }) => ({
            triggerSource: event.source ?? 'Manual Button',
            secondsRemaining: context.countdownTotal,
          })),
        },
      },
    },
    countdown: {
      entry: 'startCountdownService',
      invoke: { src: 'countdownTicker' },
      on: {
        CANCEL: 'idle',
        MARK_SAFE: 'idle',
        TICK: [
          { guard: 'countdownFinished', target: 'dispatching' },
          { actions: assign(({ context }) => ({ secondsRemaining: context.secondsRemaining - 1 })) },
        ],
      },
    },
    dispatching: {
      entry: [
        'startDispatchingService',
        'acquireWakeLock',
        assign({
          startedAt: () => Date.now(),
          sessionId: () => `${Date.now()}`,
          lastError: () => null,
        }),
      ],
      exit: 'releaseWakeLock',
      invoke: {
        src: 'dispatchEmergency',
        input: ({ context }) => ({ context }),
        onDone: {
          target: 'active',
          actions: [
            assign(({ event }) => ({ location: event.output.location })),
            'updateActiveNotification',
            'releaseWakeLock',
          ],
        },
        onError: {
          target: 'active',
          actions: [
            assign({
              lastError: ({ event }) =>
                event.error instanceof Error ? event.error.message : String(event.error),
              location: ({ event }) =>
                event.error && typeof event.error === 'object' && 'location' in event.error
                  ? (event.error as any).location
                  : null,
            }),
            'releaseWakeLock',
          ],
        },
      },
    },
    active: {
      entry: 'releaseWakeLock',
      on: {
        MARK_SAFE: 'resolving',
        DISMISS: {
          target: 'idle',
          actions: assign(() => initialContext),
        },
      },
    },
    resolving: {
      entry: 'acquireWakeLock',
      exit: 'releaseWakeLock',
      invoke: {
        src: 'dispatchSafe',
        input: ({ context }) => ({ context }),
        onDone: { target: 'idle', actions: assign(() => initialContext) },
        onError: { target: 'idle', actions: assign(() => initialContext) },
      },
    },
  },
});

let sharedSosService: ReturnType<typeof createActor<typeof sosMachine>> | null = null;

/**
 * Returns the singleton running instance of the emergency state machine actor.
 * Ensures hardware panic triggers (volume / shake) immediately execute background
 * dispatch and SMS sending without requiring UI presence or PIN unlock.
 */
export function getSosService() {
  if (!sharedSosService) {
    sharedSosService = createActor(sosMachine);
    sharedSosService.start();
  }
  return sharedSosService;
}

/**
 * Resets the singleton emergency state machine actor (stops it and clears reference).
 * Useful for test suites and security resets.
 */
export function resetSosService(): void {
  if (sharedSosService) {
    try {
      sharedSosService.stop();
    } catch {}
    sharedSosService = null;
  }
}

/**
 * React hook to subscribe to the global emergency state machine.
 */
export function useSosService() {
  const service = getSosService();
  const snapshot = useSelector(service, (s) => s);
  return [snapshot, (event: SosEvent) => service.send(event)] as const;
}

