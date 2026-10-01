package expo.modules.physicaltriggers

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * Native accessibility service for detecting volume button press sequences
 * even when the screen is locked or another app is focused.
 */
class EricaAccessibilityService : AccessibilityService() {

  companion object {
    private const val TAG = "EricaAccessibility"
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    Log.i(TAG, "EricaAccessibilityService connected and ready")
    PhysicalTriggersModule.systemContext = applicationContext
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Accessibility events not required for key monitoring
  }

  override fun onInterrupt() {
    Log.d(TAG, "EricaAccessibilityService interrupted")
  }

  override fun onKeyEvent(event: KeyEvent): Boolean {
    if (PhysicalTriggersModule.systemContext == null) {
      PhysicalTriggersModule.systemContext = applicationContext
    }
    // Forward volume keys to the PhysicalTriggersModule
    val handled = PhysicalTriggersModule.onKeyEvent(event)
    return if (handled) {
      true
    } else {
      super.onKeyEvent(event)
    }
  }
}
