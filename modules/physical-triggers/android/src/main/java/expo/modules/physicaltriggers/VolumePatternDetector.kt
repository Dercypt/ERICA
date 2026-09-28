package expo.modules.physicaltriggers

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Native detector for volume button sequences (e.g., 4 presses within 3 seconds).
 * Strictly filters out key repeats (holding button down) and hardware bounce to avoid false alarms.
 */
class VolumePatternDetector(
  var onTrigger: ((String) -> Unit)? = null
) {
  companion object {
    private const val TAG = "VolumePatternDetector"
    const val DEFAULT_PRESS_COUNT = 4
    const val DEFAULT_WINDOW_MS = 3000L
    const val DEFAULT_DEBOUNCE_MS = 100L
    const val DEFAULT_COOLDOWN_MS = 3000L
  }

  @Volatile
  var isEnabled: Boolean = false

  @Volatile
  var targetPressCount: Int = DEFAULT_PRESS_COUNT

  @Volatile
  var windowDurationMs: Long = DEFAULT_WINDOW_MS

  @Volatile
  var debounceMs: Long = DEFAULT_DEBOUNCE_MS

  @Volatile
  var cooldownMs: Long = DEFAULT_COOLDOWN_MS

  private val pressTimestamps = CopyOnWriteArrayList<Long>()
  private var lastPressTimeMs: Long = 0
  private var lastTriggerTimeMs: Long = 0

  @Synchronized
  fun configure(enabled: Boolean, pressCount: Int? = null, windowMs: Long? = null) {
    this.isEnabled = enabled
    pressCount?.let { if (it > 0) this.targetPressCount = it }
    windowMs?.let { if (it > 0) this.windowDurationMs = it }
    if (!enabled) {
      reset()
    }
    Log.d(TAG, "Configured VolumePatternDetector: enabled=$isEnabled, count=$targetPressCount, window=${windowDurationMs}ms")
  }

  @Synchronized
  fun reset() {
    pressTimestamps.clear()
    lastPressTimeMs = 0
  }

  /**
   * Evaluates key events received from MainActivity dispatchKeyEvent or AccessibilityService.
   * Returns true if event is a volume key press handled by the detector.
   */
  fun onKeyEvent(event: KeyEvent): Boolean {
    if (!isEnabled) {
      return false
    }

    val keyCode = event.keyCode
    val isVolumeKey = keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP
    if (!isVolumeKey) {
      return false
    }

    if (event.action != KeyEvent.ACTION_DOWN) {
      return false
    }

    // STRICT FALSE ALARM CHECK:
    // Holding the button causes Android to generate repeat events (repeatCount > 0).
    // We strictly ignore repeat events to ensure only intentional distinct presses count.
    if (event.repeatCount > 0) {
      return false
    }

    val now = SystemClock.uptimeMillis()
    return recordPress(now)
  }

  @Synchronized
  fun recordPress(now: Long = SystemClock.uptimeMillis()): Boolean {
    if (!isEnabled) {
      return false
    }

    // Debounce to eliminate mechanical switch bounce
    if (now - lastPressTimeMs < debounceMs) {
      return false
    }
    lastPressTimeMs = now

    // Cooldown check following previous alert
    if (now - lastTriggerTimeMs < cooldownMs) {
      return false
    }

    // Filter out old presses outside the sliding window
    val windowStart = now - windowDurationMs
    pressTimestamps.removeAll { it < windowStart }
    pressTimestamps.add(now)

    Log.d(TAG, "Volume press registered: ${pressTimestamps.size}/$targetPressCount in window")

    if (pressTimestamps.size >= targetPressCount) {
      Log.i(TAG, "Volume button pattern detected: $targetPressCount presses within ${windowDurationMs}ms!")
      pressTimestamps.clear()
      lastTriggerTimeMs = now
      onTrigger?.invoke("Volume Button Pattern")
      return true
    }

    return false
  }

  fun getActivePressCount(now: Long = SystemClock.uptimeMillis()): Int {
    val windowStart = now - windowDurationMs
    return pressTimestamps.count { it >= windowStart }
  }
}
