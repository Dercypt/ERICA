import * as Location from 'expo-location';

export interface LocationResult {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: number;
}

/** Longest the SOS path waits for a fresh GPS fix before falling back to last-known. */
export const LOCATION_FIX_TIMEOUT_MS = 15_000;

/**
 * Asks for foreground location permission. Call from the UI ahead of time; the SOS
 * path itself never prompts, because a dialog cannot be answered with the screen off
 * and would stall dispatch.
 */
export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

// SOS-alerter's approach (GPS then network provider, whichever answers first)
// is a real technique worth keeping — falling back to a last-known fix beats
// sending no location at all when a fresh GPS lock times out mid-emergency.
//
// Never throws and never waits longer than `timeoutMs`: getCurrentPositionAsync can
// hang indoors with no fix, and a rejection here used to abort the whole alert.
export async function getCurrentLocation(
  timeoutMs: number = LOCATION_FIX_TIMEOUT_MS
): Promise<LocationResult | null> {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null),
      timeout,
    ]);
    clearTimeout(timer);
    if (fresh) {
      return toResult(fresh);
    }

    const lastKnown = await Location.getLastKnownPositionAsync().catch(() => null);
    return lastKnown ? toResult(lastKnown) : null;
  } catch {
    return null;
  }
}

function toResult(position: Location.LocationObject): LocationResult {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp,
  };
}

export function mapsLinkFor(location: LocationResult): string {
  return `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
}
