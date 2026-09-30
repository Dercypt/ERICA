const listeners = new Set();

export const AppState = {
  currentState: 'active',
  addEventListener(type, listener) {
    if (type === 'change') {
      listeners.add(listener);
      return {
        remove: () => listeners.delete(listener),
      };
    }
    return { remove: () => {} };
  },
  _setAppState(newState) {
    this.currentState = newState;
    for (const listener of Array.from(listeners)) {
      listener(newState);
    }
  },
  _reset() {
    this.currentState = 'active';
    listeners.clear();
  },
};

export const StyleSheet = {
  create: (styles) => styles,
};

export const Platform = {
  OS: 'android',
  select: (obj) => obj.android ?? obj.default,
};

export class View {}
export class Text {}
export class Pressable {}
export class TextInput {}
export class ScrollView {}
export class Switch {}

export const Alert = {
  alert: (title, message, buttons) => {},
};

export const TurboModuleRegistry = {
  get: () => null,
  getEnforcing: (name) => {
    throw new Error(`TurboModule ${name} not available in mock`);
  },
};

export default {
  AppState,
  StyleSheet,
  Platform,
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  Switch,
  Alert,
  TurboModuleRegistry,
};
