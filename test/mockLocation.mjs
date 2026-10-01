export async function requestForegroundPermissionsAsync() {
  return { status: 'granted' };
}

export async function getForegroundPermissionsAsync() {
  return { status: mockLocationState.permission };
}

export const mockLocationState = { permission: 'granted', hang: false, lastKnown: null };

export function resetMockLocation() {
  mockLocationState.permission = 'granted';
  mockLocationState.hang = false;
  mockLocationState.lastKnown = null;
}

export async function getCurrentPositionAsync() {
  if (mockLocationState.hang) {
    return new Promise(() => {});
  }
  return {
    coords: {
      latitude: 14.599512,
      longitude: 120.984222,
      accuracy: 5,
    },
    timestamp: Date.now(),
  };
}

export async function getLastKnownPositionAsync() {
  return mockLocationState.lastKnown;
}

export const Accuracy = {
  Lowest: 1,
  Low: 2,
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
};

export default {
  requestForegroundPermissionsAsync,
  getForegroundPermissionsAsync,
  getCurrentPositionAsync,
  getLastKnownPositionAsync,
  Accuracy,
};
