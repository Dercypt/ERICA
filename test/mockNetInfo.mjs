export const NetInfoStateType = {
  cellular: 'cellular',
  wifi: 'wifi',
  none: 'none',
  unknown: 'unknown',
};

export default {
  addEventListener: () => () => {},
  fetch: async () => ({
    type: 'cellular',
    isConnected: true,
    isInternetReachable: true,
    details: { isConnectionExpensive: false },
  }),
};
