const {
  createRunOncePlugin,
  withAndroidManifest,
  withMainActivity,
  AndroidConfig,
} = require('@expo/config-plugins');

const ERICA_PERMISSIONS = [
  'android.permission.SEND_SMS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.WAKE_LOCK',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'android.permission.CAMERA',
  'android.permission.FLASHLIGHT',
  'android.permission.RECORD_AUDIO',
];

/**
 * Expo Config Plugin to inject required native Android permissions into AndroidManifest.xml.
 *
 * Permissions:
 * - SEND_SMS: Allows silent sending of SMS for SOS dispatch
 * - READ_PHONE_STATE: Allows inspecting carrier and SIM readiness
 * - ACCESS_BACKGROUND_LOCATION: Allows background location fixes when screen is off
 * - FOREGROUND_SERVICE: Allows persistent emergency foreground service
 * - FOREGROUND_SERVICE_LOCATION: Android 14+ compliance for location foreground service type
 * - WAKE_LOCK: Prevents CPU sleep during active SOS dispatch sequence
 * - RECEIVE_BOOT_COMPLETED: Allows auto-recovery / watchdog readiness after device reboot
 * - POST_NOTIFICATIONS: Notifications for emergency status and armed countdown
 * - USE_BIOMETRIC: Allows biometric verification (Fingerprint / Face Unlock)
 * - USE_FINGERPRINT: Legacy biometric permission fallback for Android 9 and lower
 */
const withEricaAndroidPermissions = (config) => {
  return withAndroidManifest(config, async (config) => {
    AndroidConfig.Permissions.ensurePermissions(config.modResults, ERICA_PERMISSIONS);
    return config;
  });
};

/**
 * Pure transform function to inject Android window FLAG_SECURE into MainActivity.
 * Declares WindowManager.LayoutParams.FLAG_SECURE to blank out recent apps switcher
 * previews and block OS screenshots / screen recording.
 */
function applyFlagSecure(contents, language) {
  if (contents.includes('FLAG_SECURE')) {
    return contents;
  }

  const isKotlin = language === 'kt';
  if (isKotlin) {
    if (contents.includes('super.onCreate(')) {
      return contents.replace(
        /super\.onCreate\([^)]*\)/,
        (match) =>
          `${match}\n    // Screenshot & Task Switcher Protection: blank out Recent Apps switcher previews and block OS screenshots\n    window.setFlags(\n      android.view.WindowManager.LayoutParams.FLAG_SECURE,\n      android.view.WindowManager.LayoutParams.FLAG_SECURE\n    )`
      );
    }
  } else {
    if (contents.includes('super.onCreate(')) {
      return contents.replace(
        /super\.onCreate\([^)]*\);?/,
        (match) =>
          `${match}\n    // Screenshot & Task Switcher Protection: blank out Recent Apps switcher previews and block OS screenshots\n    getWindow().setFlags(\n      android.view.WindowManager.LayoutParams.FLAG_SECURE,\n      android.view.WindowManager.LayoutParams.FLAG_SECURE\n    );`
      );
    }
  }

  return contents;
}

/**
 * Expo Config Plugin to inject Android window FLAG_SECURE into MainActivity.
 */
const withEricaFlagSecure = (config) => {
  return withMainActivity(config, (config) => {
    config.modResults.contents = applyFlagSecure(
      config.modResults.contents,
      config.modResults.language
    );
    return config;
  });
};

/**
 * Combined E.R.I.C.A. Android Config Plugin.
 */
const withEricaAndroidConfig = (config) => {
  config = withEricaAndroidPermissions(config);
  config = withEricaFlagSecure(config);
  return config;
};

module.exports = createRunOncePlugin(
  withEricaAndroidConfig,
  'withEricaAndroidConfig',
  '1.0.0'
);

module.exports.applyFlagSecure = applyFlagSecure;
module.exports.withEricaFlagSecure = withEricaFlagSecure;
module.exports.withEricaAndroidPermissions = withEricaAndroidPermissions;
module.exports.ERICA_PERMISSIONS = ERICA_PERMISSIONS;
