const {
  createRunOncePlugin,
  withAndroidManifest,
  withMainActivity,
  withSettingsGradle,
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
 * Pure transform that forwards MainActivity key events to the physical-triggers module,
 * so the volume-button pattern is detected while the app is in the foreground even when
 * the accessibility service is not enabled. This used to exist only as a hand edit to the
 * generated MainActivity and was lost on `expo prebuild --clean`.
 */
function applyKeyEventHook(contents, language) {
  if (contents.includes('dispatchKeyEvent')) {
    return contents;
  }
  const end = contents.lastIndexOf('}');
  if (end === -1) {
    return contents;
  }
  const hook =
    language === 'kt'
      ? `
  /**
   * Intercept hardware key events (e.g. volume buttons) to detect emergency trigger patterns.
   */
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    expo.modules.physicaltriggers.PhysicalTriggersModule.onKeyEvent(event)
    return super.dispatchKeyEvent(event)
  }
`
      : `
  /**
   * Intercept hardware key events (e.g. volume buttons) to detect emergency trigger patterns.
   */
  @Override
  public boolean dispatchKeyEvent(android.view.KeyEvent event) {
    expo.modules.physicaltriggers.PhysicalTriggersModule.Companion.onKeyEvent(event);
    return super.dispatchKeyEvent(event);
  }
`;
  return contents.slice(0, end) + hook + contents.slice(end);
}

const FLAG_SECURE_CALL_KT = `window.setFlags(
      android.view.WindowManager.LayoutParams.FLAG_SECURE,
      android.view.WindowManager.LayoutParams.FLAG_SECURE
    )`;

/**
 * Pure transform that lets a panic trigger wake the app: shows MainActivity over the
 * keyguard and forwards the "extra_panic_trigger" intent extra (sent by
 * PhysicalTriggersModule when the JS runtime is not running) to the trigger module.
 * Kotlin only; must run after applyFlagSecure, which it anchors on. These edits used to
 * be hand-written into the generated MainActivity and were lost on `expo prebuild --clean`.
 */
function applyPanicIntentHooks(contents, language) {
  if (language !== 'kt' || contents.includes('handleIncomingIntent')) {
    return contents;
  }
  const anchor = contents.indexOf(FLAG_SECURE_CALL_KT);
  const end = contents.lastIndexOf('}');
  if (anchor === -1 || end === -1) {
    return contents;
  }
  const afterAnchor = anchor + FLAG_SECURE_CALL_KT.length;
  const onCreateAddition = `

    // Allow displaying emergency status over lockscreen when triggered
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(
        android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      )
    }

    handleIncomingIntent(intent)`;
  const methods = `
  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent)
  }

  private fun handleIncomingIntent(intent: android.content.Intent?) {
    val panicSource = intent?.getStringExtra("extra_panic_trigger")
    if (!panicSource.isNullOrEmpty()) {
      expo.modules.physicaltriggers.PhysicalTriggersModule.sendPanicEvent(panicSource)
    }
  }
`;
  return (
    contents.slice(0, afterAnchor) +
    onCreateAddition +
    contents.slice(afterAnchor, end) +
    methods +
    contents.slice(end)
  );
}

/**
 * Disables Android Auto Backup. Backups would upload the encrypted stores without the
 * Keystore-bound key, so a restore yields data that can never be decrypted, and a
 * privacy-first app should not ship user data to cloud backup by default.
 */
const withEricaDisableBackup = (config) => {
  return withAndroidManifest(config, async (config) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    app.$['android:allowBackup'] = 'false';
    return config;
  });
};

/**
 * Gradle 9 rejects dots in project names, and prebuild derives the name from the app
 * display name "E.R.I.C.A.". Previously fixed by hand in settings.gradle and lost on
 * every `expo prebuild --clean`.
 */
function applyGradleProjectName(contents) {
  return contents.replace(/rootProject\.name\s*=\s*['"][^'"]*['"]/, "rootProject.name = 'ERICA'");
}

const withEricaGradleProjectName = (config) => {
  return withSettingsGradle(config, (config) => {
    config.modResults.contents = applyGradleProjectName(config.modResults.contents);
    return config;
  });
};

/**
 * Expo Config Plugin to inject Android window FLAG_SECURE into MainActivity.
 */
const withEricaFlagSecure = (config) => {
  return withMainActivity(config, (config) => {
    const { language } = config.modResults;
    const withFlagSecure = applyFlagSecure(config.modResults.contents, language);
    config.modResults.contents = applyKeyEventHook(
      applyPanicIntentHooks(withFlagSecure, language),
      language
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
  config = withEricaDisableBackup(config);
  config = withEricaGradleProjectName(config);
  return config;
};

module.exports = createRunOncePlugin(
  withEricaAndroidConfig,
  'withEricaAndroidConfig',
  '1.0.0'
);

module.exports.applyFlagSecure = applyFlagSecure;
module.exports.applyKeyEventHook = applyKeyEventHook;
module.exports.applyPanicIntentHooks = applyPanicIntentHooks;
module.exports.applyGradleProjectName = applyGradleProjectName;
module.exports.withEricaFlagSecure = withEricaFlagSecure;
module.exports.withEricaAndroidPermissions = withEricaAndroidPermissions;
module.exports.ERICA_PERMISSIONS = ERICA_PERMISSIONS;
