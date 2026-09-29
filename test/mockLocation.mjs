export async function requestForegroundPermissionsAsync() {
  return { status: 'granted' };
}

export async function getCurrentPositionAsync() {
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
  return null;
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
  getCurrentPositionAsync,
  getLastKnownPositionAsync,
  Accuracy,
};
