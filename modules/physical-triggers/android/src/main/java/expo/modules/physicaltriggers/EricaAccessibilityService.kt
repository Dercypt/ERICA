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

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    // Accessibility events not required for key monitoring
  }

  override fun onInterrupt() {
    Log.d(TAG, "EricaAccessibilityService interrupted")
  }

  override fun onKeyEvent(event: KeyEvent): Boolean {
    // Forward volume keys to the PhysicalTriggersModule
    val handled = PhysicalTriggersModule.onKeyEvent(event)
    return if (handled) {
      true
    } else {
      super.onKeyEvent(event)
    }
  }
}
